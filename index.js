import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import { execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import * as yaml from "js-yaml";
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";

import { buildMessages } from "./prompts.js";
import {
  readBaseline, writeBaseline, ensureBaselineDir,
  shouldSkipComment, recordComments
} from "./baseline.js";

dotenv.config();

/* =======================
   Config / Globals
======================= */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || "";
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "";

// Always post the combined comment (even when 0 findings/tests)
const ALWAYS_COMMENT = (process.env.NEURON_ALWAYS_COMMENT || "true").toLowerCase() === "true";
const DEBUG = (process.env.DEBUG_RENDER || "").toLowerCase() === "true";
// When true, post a tiny trace comment even if something fails mid-run
const DEBUG_COMMENTS = (process.env.NEURON_DEBUG_COMMENTS || "true").toLowerCase() === "true";

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai =
  AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY
    ? new OpenAIClient(AZURE_OPENAI_ENDPOINT, new AzureKeyCredential(AZURE_OPENAI_KEY))
    : null;

/* =======================
   Express Setup
======================= */

const app = express();

app.get("/", (_req, res) => {
  res.send("Neuron webhook (LLM mode) running");
});

app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    env: {
      WEBHOOK_SECRET: !!WEBHOOK_SECRET,
      GITHUB_TOKEN: !!GITHUB_TOKEN,
      AZURE_OPENAI_ENDPOINT: !!AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_KEY: !!AZURE_OPENAI_KEY,
      AZURE_OPENAI_DEPLOYMENT: !!AZURE_OPENAI_DEPLOYMENT,
      ALWAYS_COMMENT,
      DEBUG,
      DEBUG_COMMENTS
    }
  });
});

app.post("/webhook", async (req, res) => {
  // run-trace breadcrumbs; we’ll post these if anything fails
  const trace = [];
  let owner = "", repo = "", pull_number = 0;

  try {
    const raw = await getRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];

    trace.push("received");

    if (!verifySignature(sig, raw)) {
      trace.push("signature_invalid");
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(raw.toString("utf8"));
    trace.push(`event=${event}`);

    if (event !== "pull_request") {
      trace.push("ignored_event");
      return res.status(200).send("Ignored");
    }
    const action = payload.action;
    if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) {
      trace.push(`ignored_action=${action}`);
      return res.status(200).send("No-op for this PR action");
    }

    const pr = payload.pull_request;
    owner = payload.repository.owner.login;
    repo = payload.repository.name;
    pull_number = pr.number;

    // IMPORTANT: we will commit to the PR HEAD repo/branch
    const headOwner = pr.head.repo.owner.login;
    const headRepo = pr.head.repo.name;
    const headRef = pr.head.ref;

    console.log(`[info] Handling PR #${pull_number} @ ${owner}/${repo}`);
    trace.push("start_handle_pull_request");

    if (!openai || !AZURE_OPENAI_DEPLOYMENT) {
      trace.push("azure_missing");
      await postIssueComment(owner, repo, pull_number,
        "⚠️ Neuron could not generate a plan — **AZURE_CONFIG_MISSING** (endpoint/key/deployment not set).");
      return res.status(200).send("OK");
    }

    // Workdir & clone (we still clone to read/write files locally)
    const cloneUrl = pr.head.repo.clone_url.replace("https://", `https://x-access-token:${GITHUB_TOKEN}@`);
    const workdir = tmpDir("neuron-");
    console.log("[info] workdir:", workdir);
    exec(`git clone --depth=50 --branch "${headRef}" "${cloneUrl}" "${workdir}"`);
    trace.push("cloned");

    // Changed files (cap + trim patches)
    const filesResp = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
    const changedRaw = filesResp.data || [];
    const changed = trimChangedFiles(changedRaw);
    trace.push(`changed=${changed.length}`);

    // Signals (auto-detected repo hints)
    const signals = collectRepoSignals(workdir);

    // Languages / frameworks
    const languages = detectLanguages(changed, workdir);
    const testFrameworks = frameworkMap(languages);

    // Existing test snippets (capped)
    const existingTests = sampleExistingTests(workdir);

    const cfg = readNeuronConfig(workdir);

    const input = {
      repo_meta: {
        owner, repo,
        headRef,
        languages,
        test_frameworks: testFrameworks,
        package_manager: detectPackageManager(workdir)
      },
      signals,
      changed_files: changed,
      existing_tests: existingTests,
      requirements: {
        max_comments: cfg.max_inline_comments ?? 3
      }
    };

    // Build messages with compact context
    const messages = buildMessages(input, JSON.stringify(JSON_SCHEMA));

    // Get plan (JSON mode first, then fallback)
    trace.push("llm_request");
    const { plan, diag } = await getLLMPlanWithFallback(messages);
    trace.push(`llm=${diag?.code || "unknown"}`);

    if (!plan) {
      await postCombined(owner, repo, pull_number, { comments: [], tests: [] }, { tests_written: [] }, {
        languages,
        changedCount: changed.length,
        diagCode: diag?.code || "ERROR"
      }, trace);
      return res.status(200).send("OK");
    }

    // Baseline: avoid repeats
    ensureBaselineDir(workdir);
    const baseline = readBaseline(workdir);
    const filteredComments = (plan.comments || []).filter(c => !shouldSkipComment(workdir, baseline, c)).slice(0, 3);
    const filteredPlan = { ...plan, comments: filteredComments };
    trace.push(`comments_after_baseline=${filteredComments.length}`);

    // Apply plan (write tests only; no comment posting here)
    const applied = await applyPlan(workdir, filteredPlan);
    trace.push(`tests_written=${applied.tests_written.length}`);

    // Update baseline with posted comments (only the ones we actually keep)
    const baselineChanged = recordComments(workdir, baseline, filteredComments);
    if (baselineChanged) {
      writeBaseline(workdir, baseline);
    }

    // Collect files to commit via API (NOT git push)
    const filesToCommit = [...(applied.tests_written || [])];
    if (baselineChanged) filesToCommit.push(".neuron/baseline.json");

    if (filesToCommit.length) {
      for (const rel of filesToCommit) {
        const abs = path.join(workdir, rel);
        const content = fs.readFileSync(abs, "utf8");
        await upsertFileViaAPI({
          owner: headOwner,
          repo: headRepo,
          branch: headRef,
          filepath: rel.replace(/\\/g, "/"),
          message: "chore(neuron): generated tests & updated baseline",
          content
        });
      }
      trace.push("committed_via_api");
    } else {
      trace.push("nothing_to_commit");
    }

    // Post one combined comment (summary at top; findings/tests below if present)
    if (ALWAYS_COMMENT) {
      await postCombined(owner, repo, pull_number, filteredPlan, applied, {
        languages,
        changedCount: changed.length,
        diagCode: diag?.code || "OK"
      }, trace);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[error] webhook handler failed:", err);
    // Fallback: post a tiny trace so the PR never goes silent
    if (DEBUG_COMMENTS && owner && repo && pull_number) {
      const msg = (err && (err.message || String(err))) || "unknown";
      try {
        await postIssueComment(owner, repo, pull_number,
          `⚠️ Neuron run failed early.\n\nTrace: ${trace.map(t => `\`${t}\``).join(" · ")}\n\nError: \`${msg.slice(0, 300)}\``);
      } catch {}
    }
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`Neuron webhook listening on :${PORT}`);
});

/* =======================
   Utilities
======================= */

function verifySignature(sigHeader, raw) {
  // IMPORTANT: if no secret configured, allow the webhook instead of rejecting
  if (!WEBHOOK_SECRET) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

function tmpDir(prefix) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return p;
}

function exec(cmd, opts = {}) {
  DEBUG && console.log("[exec]", cmd);
  return execSync(cmd, { stdio: DEBUG ? "inherit" : "ignore", ...opts });
}

function readFileIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/* =======================
   JSON Schema for LLM Plan
======================= */

const JSON_SCHEMA = {
  type: "object",
  required: ["comments", "tests"],
  properties: {
    comments: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["path", "line", "severity", "title", "body"],
        properties: {
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          title: { type: "string", maxLength: 120 },
          body: { type: "string", maxLength: 2000 }
        }
      }
    },
    tests: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        required: ["language", "framework", "path", "mode", "content"],
        properties: {
          language: { type: "string" },
          framework: { type: "string" },
          path: { type: "string" },
          mode: { type: "string", enum: ["create", "append_or_create", "replace"] },
          content: { type: "string", minLength: 1 }
        }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validatePlan = ajv.compile(JSON_SCHEMA);

/* =======================
   PR Handler helpers
======================= */

function trimChangedFiles(files) {
  const MAX_FILES = 25;
  const MAX_PATCH_CHARS_PER_FILE = 5000;
  const out = [];
  for (const f of files.slice(0, MAX_FILES)) {
    let patch = f.patch || "";
    if (patch.length > MAX_PATCH_CHARS_PER_FILE) {
      patch = patch.slice(0, MAX_PATCH_CHARS_PER_FILE) + "\n@@ ...patch truncated by Neuron @@";
    }
    out.push({
      path: f.filename,
      patch,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes
    });
  }
  return out;
}

function collectRepoSignals(workdir) {
  const pkg = readJsonSafe(path.join(workdir, "package.json"));
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const depsList = Object.keys(deps || {}).slice(0, 40);
  const envExample = readFileIfExists(path.join(workdir, ".env")).slice(0, 2000);
  const readme = readFileIfExists(path.join(workdir, "README.md")).slice(0, 2000);

  const routes = findFiles(workdir, ["pages", "routes", "api"], [".js", ".ts", ".tsx"]).slice(0, 30);
  const schema = findFiles(workdir, ["schema", "prisma", "migrations", "db"], [".sql", ".prisma", ".ts"]).slice(0, 30);
  const testNames = findFiles(workdir, ["__tests__", "tests", "src/test"], [".test.js", ".spec.js", ".test.ts", ".java", ".py"]).slice(0, 30);

  return {
    deps: depsList,
    stack_hints: {
      react: !!deps["react"] || !!deps["next"],
      nextjs: !!deps["next"],
      express: !!deps["express"],
      stripe: !!deps["stripe"] || !!deps["@stripe/stripe-js"],
      prisma: !!deps["@prisma/client"],
      graphql: !!deps["graphql"] || !!deps["@apollo/client"] || !!deps["@apollo/server"],
      axios: !!deps["axios"]
    },
    env_snippet: envExample,
    readme_snippet: readme,
    route_files: routes,
    schema_files: schema,
    test_files: testNames
  };
}

function findFiles(root, folders, exts) {
  const results = [];
  function walk(dir, depth = 0) {
    if (depth > 3) return;
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of list) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 || folders.some(f => p.includes(`/${f}`))) walk(p, depth + 1);
      } else {
        const lower = entry.name.toLowerCase();
        if (exts.some(ext => lower.endsWith(ext))) {
          results.push(path.relative(root, p));
        }
      }
    }
  }
  walk(root, 0);
  return results;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function detectLanguages(changed, workdir) {
  const set = new Set();
  for (const f of changed) {
    if (f.path.endsWith(".ts") || f.path.endsWith(".tsx")) set.add("typescript");
    else if (f.path.endsWith(".js") || f.path.endsWith(".jsx")) set.add("javascript");
    else if (f.path.endsWith(".java")) set.add("java");
    else if (f.path.endsWith(".py")) set.add("python");
  }
  if (fs.existsSync(path.join(workdir, "package.json"))) set.add("javascript");
  return Array.from(set);
}

function frameworkMap(langs) {
  const map = {};
  for (const l of langs) {
    if (l === "typescript" || l === "javascript") map[l] = "jest";
    else if (l === "java") map[l] = "junit";
    else if (l === "python") map[l] = "pytest";
  }
  return map;
}

function detectPackageManager(workdir) {
  if (fs.existsSync(path.join(workdir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(workdir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(workdir, "package-lock.json"))) return "npm";
  return "unknown";
}

function sampleExistingTests(workdir) {
  const out = [];
  function addDir(rel) {
    const abs = path.join(workdir, rel);
    if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) {
      const files = fs.readdirSync(abs)
        .filter(f => f.endsWith(".test.js") || f.endsWith(".spec.js") || f.endsWith(".test.ts") || f.endsWith(".java") || f.endsWith(".py"))
        .slice(0, 8);
      for (const f of files) {
        const p = path.join(abs, f);
        const txt = fs.readFileSync(p, "utf8");
        out.push({ path: path.relative(workdir, p), snippet: txt.slice(0, 1000) });
      }
    }
  }
  addDir("__tests__");
  addDir("tests");
  addDir("src/test/java");
  return out.slice(0, 20);
}

function readNeuronConfig(workdir) {
  const p = path.join(workdir, "neuron.config.yml");
  if (!fs.existsSync(p)) return {};
  try { return (yaml.load(fs.readFileSync(p, "utf8"))?.neuron) || {}; } catch { return {}; }
}

/* =======================
   Azure LLM (JSON mode + fallback)
======================= */

async function getLLMPlanWithFallback(messages) {
  try {
    const resp = await openai.getChatCompletions(AZURE_OPENAI_DEPLOYMENT, messages, {
      temperature: 0.2,
      maxTokens: 1200,
      responseFormat: { type: "json_object" }
    });
    const content = resp.choices?.[0]?.message?.content || "";
    const plan = JSON.parse(content);
    if (!validatePlan(plan)) {
      return { plan: null, diag: { code: "SCHEMA_INVALID", detail: JSON.stringify(validatePlan.errors).slice(0, 500) } };
    }
    return { plan, diag: { code: "OK_JSON_MODE" } };
  } catch (err) {
    DEBUG && console.warn("[warn] JSON mode failed; falling back:", err?.message || err);
  }
  try {
    const forced = [
      ...messages,
      { role: "system", content: "Return ONLY a JSON object with keys `comments` (array) and `tests` (array). No prose outside JSON." }
    ];
    const resp = await openai.getChatCompletions(AZURE_OPENAI_DEPLOYMENT, forced, {
      temperature: 0.1,
      maxTokens: 1400
    });
    const raw = resp.choices?.[0]?.message?.content || "";
    const candidate = extractFirstJsonObject(raw);
    if (!candidate) return { plan: null, diag: { code: "JSON_MISSING", detail: raw.slice(0, 350) } };
    const plan = JSON.parse(candidate);
    if (!validatePlan(plan)) {
      return { plan: null, diag: { code: "SCHEMA_INVALID", detail: JSON.stringify(validatePlan.errors).slice(0, 500) } };
    }
    return { plan, diag: { code: "OK_FALLBACK" } };
  } catch (err2) {
    const msg = (err2 && (err2.message || String(err2))) || "unknown";
    const code =
      /quota|rate/i.test(msg) ? "AZURE_QUOTA" :
      /unauthorized|401|forbidden|403/i.test(msg) ? "AZURE_AUTH" :
      /model|deployment/i.test(msg) ? "AZURE_DEPLOYMENT" :
      "MODEL_REJECT";
    return { plan: null, diag: { code, detail: msg.slice(0, 400) } };
  }
}

function extractFirstJsonObject(text) {
  const fence = text.indexOf("```");
  if (fence !== -1) {
    const fenceEnd = text.indexOf("```", fence + 3);
    const inside = fenceEnd !== -1 ? text.slice(fence + 3, fenceEnd) : text.slice(0);
    const s = inside.indexOf("{"), e = inside.lastIndexOf("}");
    if (s !== -1 && e !== -1 && e > s) return inside.slice(s, e + 1);
  }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e !== -1 && e > s) return text.slice(s, e + 1);
  return "";
}

/* =======================
   Plan Application (no comment posting here)
======================= */

function ensureSafePath(root, rel, fallback) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root))) return path.join(root, fallback);
  return abs;
}

function withChecksum(content) {
  const h = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return `// neuron:generated checksum=${h}\n${content}\n`;
}

function alreadyHasChecksum(content) {
  return /neuron:generated checksum=([a-f0-9]{64})/.test(content);
}

async function applyPlan(workdir, plan) {
  const written = [];

  // Tests
  for (const t of plan.tests || []) {
    const defaultPath = t.language === "java"
      ? "src/test/java/NeuronGeneratedTest.java"
      : "__tests__/neuron.generated.test.js";
    const target = ensureSafePath(workdir, t.path, defaultPath);
    const mode = t.mode || "append_or_create";

    let existing = "";
    if (fs.existsSync(target)) {
      existing = fs.readFileSync(target, "utf8");
      if (alreadyHasChecksum(existing) && existing.includes(t.content)) {
        console.log("[info] Skip unchanged test:", path.relative(workdir, target));
        continue;
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }

    let next = t.content;
    if (mode === "append_or_create" && existing) {
      next = existing + "\n\n" + t.content;
    }
    const final = withChecksum(next);
    fs.writeFileSync(target, final, "utf8");
    written.push(path.relative(workdir, target));
  }

  return { tests_written: written, comments_posted: (plan.comments || []).length };
}

/* =======================
   GitHub Contents API commit helper
======================= */

async function upsertFileViaAPI({ owner, repo, branch, filepath, message, content }) {
  // get sha if exists
  let sha;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filepath, ref: branch });
    if (!Array.isArray(data) && data.sha) sha = data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filepath,
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    sha
  });
}

/* =======================
   Combined Comment (summary + findings + tests)
======================= */

async function postCombined(owner, repo, pull_number, plan, applied, meta, trace = []) {
  const comments = plan.comments || [];
  const tests = plan.tests || [];
  const wrote = applied.tests_written || [];

  let body = `**Neuron — Summary**\n\n`;
  body += `- Findings suggested: **${comments.length}**\n`;
  body += `- Test artifacts suggested: **${tests.length}**\n`;
  body += `- Test files written: **${wrote.length}**\n`;
  if (wrote.length) {
    body += wrote.map(w => `  - \`${w}\``).join("\n") + "\n";
  }

  body += `\n**Context**\n`;
  body += `- Languages detected: ${meta.languages?.length ? meta.languages.join(", ") : "(none)"}\n`;
  body += `- Changed files analyzed: ${meta.changedCount}\n`;
  body += `- LLM mode: ${meta.diagCode}\n`;

  if (comments.length === 0 && tests.length === 0) {
    body += `\n_No business-impact issues detected and no test cases proposed by the model._\n`;
    body += `\n> Tip: add \`/business/rules.md\` or \`/business/checklists.yaml\` for stronger domain hints (optional).`;
  }

  if (comments.length) {
    body += `\n---\n\n**Neuron — Business-context review**\n\n`;
    for (const c of comments) {
      body += `- **${c.severity}** \`${c.path}:${c.line}\` — **${c.title}**\n\n  ${c.body}\n\n`;
    }
  }

  if (tests.length) {
    body += `\n**Generated/updated tests:**\n`;
    if (wrote.length) {
      body += wrote.map(w => `- \`${w}\``).join("\n") + "\n";
    } else {
      body += `- (no file changes written in this run)\n`;
    }
  }

  if (DEBUG_COMMENTS && trace?.length) {
    body += `\n<sub>trace: ${trace.map(t => `\`${t}\``).join(" · ")}</sub>`;
  }

  await postIssueComment(owner, repo, pull_number, body);
}

async function postIssueComment(owner, repo, issue_number, body) {
  try {
    await octokit.issues.createComment({ owner, repo, issue_number, body });
  } catch (e) {
    console.error("[error] Failed to post PR comment:", e);
  }
}
