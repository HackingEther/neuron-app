import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import { execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import * as yaml from "js-yaml";

// Azure OpenAI
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";

dotenv.config();

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || "";
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "";

if (!WEBHOOK_SECRET) {
  console.warn("[warn] WEBHOOK_SECRET is not set");
}
if (!GITHUB_TOKEN) {
  console.warn("[warn] GITHUB_TOKEN is not set; Git operations will likely fail");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai =
  AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY
    ? new OpenAIClient(AZURE_OPENAI_ENDPOINT, new AzureKeyCredential(AZURE_OPENAI_KEY))
    : null;

const app = express();

// We need raw body for signature verification
app.post("/webhook", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];
    if (!verifySignature(sig, raw)) {
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(raw.toString("utf8"));
    if (event !== "pull_request") {
      return res.status(200).send("Ignored");
    }
    const action = payload.action;
    if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) {
      return res.status(200).send("No-op for this PR action");
    }

    // Process PR
    await handlePullRequest(payload);
    res.status(200).send("OK");
  } catch (err) {
    console.error("[error] webhook handler failed:", err);
    res.status(500).send("Error");
  }
});

app.get("/", (_req, res) => {
  res.send("Neuron webhook (LLM mode) running");
});

app.listen(PORT, () => {
  console.log(`Neuron webhook listening on :${PORT}`);
});

/* ----------------------- helpers ------------------------ */

function verifySignature(sigHeader, raw) {
  if (!WEBHOOK_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

function tmpDir(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return base;
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

const JSON_SCHEMA = {
  type: "object",
  required: ["comments", "tests"],
  properties: {
    comments: {
      type: "array",
      maxItems: 5,
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
      maxItems: 3,
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

async function handlePullRequest(payload) {
  const pr = payload.pull_request;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pull_number = pr.number;

  console.log(`[info] Handling PR #${pull_number} @ ${owner}/${repo}`);

  const headRef = pr.head.ref;
  const headSha = pr.head.sha;
  const cloneUrl = pr.head.repo.clone_url.replace("https://", `https://x-access-token:${GITHUB_TOKEN}@`);

  // Temp working dir
  const workdir = tmpDir("neuron-");
  console.log("[info] workdir:", workdir);

  // Clone PR head
  exec(`git clone --depth=50 --branch "${headRef}" "${cloneUrl}" "${workdir}"`);

  // Collect changed files with patches
  const filesResp = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
  const changed = filesResp.data.map(f => ({
    path: f.filename,
    patch: f.patch || "",
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes
  }));

  // Gather business context from repo
  const business = readBusinessContext(workdir);

  // Detect languages/frameworks (very simple heuristic)
  const languages = detectLanguages(changed, workdir);
  const testFrameworks = frameworkMap(languages, workdir);

  // Sample existing tests (snippets only, cap by bytes)
  const existingTests = sampleExistingTests(workdir);

  // Config (from repo if present)
  const cfg = readNeuronConfig(workdir);

  const input = {
    repo_meta: {
      owner, repo, headRef, headSha,
      languages,
      test_frameworks: testFrameworks,
      package_manager: detectPackageManager(workdir)
    },
    business_rules: business.rules,
    user_stories: business.userStories,
    checklists: business.checklists,
    changed_files: changed,
    existing_tests: existingTests,
    requirements: {
      max_comments: cfg.max_inline_comments ?? 3,
      test_policy: "append_or_create",
      test_path_hints: ["__tests__/", "src/test/java/"],
      language_preference_order: ["typescript", "javascript", "java", "python"]
    }
  };

  const plan = await getLLMPlan(input);
  if (!plan) {
    await postIssueComment(owner, repo, pull_number, ":warning: Neuron could not generate a plan (LLM unavailable or invalid JSON).");
    return;
  }

  // Apply the plan: write tests, commit, push; post comments (capped)
  const applied = await applyPlan(workdir, plan, { owner, repo, pr });
  await postSummary(owner, repo, pull_number, plan, applied);
}

function readFileIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

function readBusinessContext(workdir) {
  const rules = readFileIfExists(path.join(workdir, "business", "rules.md"));
  const userStories = readFileIfExists(path.join(workdir, "business", "user_stories.md"));
  const checklistsPath = path.join(workdir, "business", "checklists.yaml");
  let checklists = "";
  try {
    if (fs.existsSync(checklistsPath)) {
      const doc = yaml.load(fs.readFileSync(checklistsPath, "utf8"));
      checklists = JSON.stringify(doc).slice(0, 4000); // cap
    }
  } catch {}
  return { rules: rules.slice(0, 8000), userStories: userStories.slice(0, 8000), checklists };
}

function detectLanguages(changed, workdir) {
  const set = new Set();
  for (const f of changed) {
    if (f.path.endsWith(".ts") || f.path.endsWith(".tsx")) set.add("typescript");
    else if (f.path.endsWith(".js") || f.path.endsWith(".jsx")) set.add("javascript");
    else if (f.path.endsWith(".java")) set.add("java");
    else if (f.path.endsWith(".py")) set.add("python");
  }
  // If no changed file hints, scan top-level package files
  if (fs.existsSync(path.join(workdir, "package.json"))) set.add("javascript");
  return Array.from(set);
}

function frameworkMap(languages, workdir) {
  const map = {};
  for (const l of languages) {
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
  function addIfExists(rel) {
    const abs = path.join(workdir, rel);
    if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) {
      const files = fs.readdirSync(abs).filter(f => f.endsWith(".test.js") || f.endsWith(".spec.js") || f.endsWith(".test.ts") || f.endsWith(".java") || f.endsWith(".py"));
      for (const f of files.slice(0, 10)) {
        const p = path.join(abs, f);
        const txt = fs.readFileSync(p, "utf8");
        out.push({ path: path.relative(workdir, p), snippet: txt.slice(0, 1200) });
      }
    }
  }
  addIfExists("__tests__");
  addIfExists("tests");
  addIfExists("src/test/java");
  return out.slice(0, 20);
}

function readNeuronConfig(workdir) {
  const p = path.join(workdir, "neuron.config.yml");
  if (!fs.existsSync(p)) return {};
  try {
    const doc = yaml.load(fs.readFileSync(p, "utf8"));
    return doc?.neuron || {};
  } catch {
    return {};
  }
}

async function getLLMPlan(input) {
  if (!openai) {
    console.warn("[warn] Azure OpenAI not configured");
    return null;
  }
  const system = [
    "You are Neuron, an expert software reviewer who enforces product/business rules.",
    "Return ONLY valid JSON that matches the provided JSON schema.",
    "Prioritize business impact over style."
  ].join(" ");

  const schemaStr = JSON.stringify(JSON_SCHEMA);

  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ ...input, json_schema: schemaStr }) }
  ];

  try {
    const result = await openai.getChatCompletions(AZURE_OPENAI_DEPLOYMENT, messages, {
      temperature: 0.2,
      maxTokens: 1200,
      responseFormat: { type: "json_object" }
    });
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;
    let plan;
    try {
      plan = JSON.parse(content);
    } catch (e) {
      console.warn("[warn] LLM returned invalid JSON, retrying once with correction");
      const retry = await openai.getChatCompletions(
        AZURE_OPENAI_DEPLOYMENT,
        [
          { role: "system", content: system },
          { role: "user", content: "Your previous response was not valid JSON. Return VALID JSON only that conforms to this schema: " + schemaStr },
          { role: "user", content: JSON.stringify(input) }
        ],
        { temperature: 0.1, maxTokens: 1200, responseFormat: { type: "json_object" } }
      );
      const content2 = retry.choices?.[0]?.message?.content;
      if (!content2) return null;
      plan = JSON.parse(content2);
    }
    const valid = validatePlan(plan);
    if (!valid) {
      console.error("[error] Plan schema invalid:", validatePlan.errors);
      return null;
    }
    return plan;
  } catch (err) {
    console.error("[error] Azure OpenAI call failed:", err);
    return null;
  }
}

function ensureSafePath(root, rel, fallback) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root))) {
    return path.join(root, fallback);
  }
  return abs;
}

function withChecksum(content) {
  const cryptoHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return `// neuron:generated checksum=${cryptoHash}\n${content}\n`;
}

function alreadyHasChecksum(content) {
  return /neuron:generated checksum=([a-f0-9]{64})/.test(content);
}

async function applyPlan(workdir, plan, ctx) {
  const { owner, repo, pr } = ctx;
  const written = [];
  const commentFingerprints = new Set();

  // Write tests
  for (const t of plan.tests || []) {
    const defaultPath = t.language === "java"
      ? "src/test/java/NeuronGeneratedTest.java"
      : "__tests__/neuron.generated.test.js";
    const safe = ensureSafePath(workdir, t.path, defaultPath);
    const mode = t.mode || "append_or_create";

    let existing = "";
    if (fs.existsSync(safe)) {
      existing = fs.readFileSync(safe, "utf8");
      if (alreadyHasChecksum(existing) && existing.includes(t.content)) {
        console.log("[info] Skipping unchanged test:", path.relative(workdir, safe));
        continue;
      }
    } else {
      fs.mkdirSync(path.dirname(safe), { recursive: true });
    }

    let newContent = t.content;
    if (mode === "append_or_create" && existing) {
      newContent = existing + "\n\n" + t.content;
    } else if (mode === "replace") {
      // use t.content as-is
    }
    const finalContent = withChecksum(newContent);
    fs.writeFileSync(safe, finalContent, "utf8");
    written.push(path.relative(workdir, safe));
  }

  // Commit & push tests (if any)
  if (written.length) {
    exec(`git -C "${workdir}" add ${written.map(w => `"${w}"`).join(" ")}`);
    exec(`git -C "${workdir}" -c user.email="neuron[bot]@example.com" -c user.name="Neuron Bot" commit -m "chore(neuron): add/update generated tests"`);
    // Push back to PR branch
    exec(`git -C "${workdir}" push origin HEAD:${pr.head.ref}`);
  }

  // Post comments (cap to 3)
  const maxComments = 3;
  const toPost = (plan.comments || []).slice(0, maxComments).filter(c => {
    const fp = `${c.path}:${c.line}:${c.title}`;
    if (commentFingerprints.has(fp)) return false;
    commentFingerprints.add(fp);
    return true;
  });

  if (toPost.length) {
    let body = `**Neuron — Business-context review**\n\n`;
    for (const c of toPost) {
      body += `- **${c.severity}** \`${c.path}:${c.line}\` — **${c.title}**\n  \n  ${c.body}\n\n`;
    }
    if (written.length) {
      body += `**Generated/updated tests:**\n${written.map(w => `- \`${w}\``).join("\n")}\n`;
    }
    await postIssueComment(owner, repo, pr.number, body);
  }

  return { tests_written: written, comments_posted: toPost.length };
}

async function postSummary(owner, repo, pull_number, plan, applied) {
  // Optional: add a compact summary comment (we already post combined above).
  // Keeping this separate in case you later split inline vs summary.
}

async function postIssueComment(owner, repo, issue_number, body) {
  try {
    await octokit.issues.createComment({ owner, repo, issue_number, body });
  } catch (e) {
    console.error("[error] Failed to post PR comment:", e);
  }
}
