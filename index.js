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

const DEBUG = (process.env.DEBUG_RENDER || "").toLowerCase() === "true";

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

// Non-secret diagnostics to debug deploys without leaking keys
app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    env: {
      WEBHOOK_SECRET: !!WEBHOOK_SECRET,
      GITHUB_TOKEN: !!GITHUB_TOKEN,
      AZURE_OPENAI_ENDPOINT: !!AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_KEY: !!AZURE_OPENAI_KEY,
      AZURE_OPENAI_DEPLOYMENT: !!AZURE_OPENAI_DEPLOYMENT
    }
  });
});

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

    await handlePullRequest(payload);
    res.status(200).send("OK");
  } catch (err) {
    console.error("[error] webhook handler failed:", err);
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
  if (!WEBHOOK_SECRET) return false;
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

/* =======================
   PR Handler
======================= */

async function handlePullRequest(payload) {
  const pr = payload.pull_request;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pull_number = pr.number;

  console.log(`[info] Handling PR #${pull_number} @ ${owner}/${repo}`);

  // Early Azure check
  if (!openai || !AZURE_OPENAI_DEPLOYMENT) {
    await postIssueComment(owner, repo, pull_number,
      "⚠️ Neuron could not generate a plan — **AZURE_CONFIG_MISSING** (endpoint/key/deployment not set).");
    return;
  }

  const headRef = pr.head.ref;
  const cloneUrl = pr.head.repo.clone_url.replace("https://", `https://x-access-token:${GITHUB_TOKEN}@`);

  // Workdir & clone
  const workdir = tmpDir("neuron-");
  console.log("[info] workdir:", workdir);
  exec(`git clone --depth=50 --branch "${headRef}" "${cloneUrl}" "${workdir}"`);

  // Changed files (cap to 100, cap patch size)
  const filesResp = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
  const changedRaw = filesResp.data || [];
  const changed = trimChangedFiles(changedRaw);

  // Business context
  const business = readBusinessContext(workdir);

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

  const { plan, diag } = await getLLMPlanWithFallback(input);

  if (!plan) {
    const reason = diag?.code || "UNKNOWN";
    const detail = diag?.detail ? `\n\n> ${diag.detail}` : "";
    await postIssueComment(owner, repo, pull_number,
      `⚠️ Neuron could not generate a plan (**${reason}**).${detail}`);
    return;
  }

  // Apply plan
  const applied = await applyPlan(workdir, plan, { owner, repo, pr });

  // Post business-context summary
  await postSummary(owner, repo, pull_number, plan, applied);
}

/* =======================
   Input Trimming / Repo Introspection
======================= */

function trimChangedFiles(files) {
  // Prevent token explosion by limiting patch size per file and total files
  const MAX_FILES = 25;
  const MAX_PATCH_CHARS_PER_FILE = 5000; // ~few screens per file
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

function readBusinessContext(workdir) {
  const rules = readFileIfExists(path.join(workdir, "business", "rules.md"));
  const userStories = readFileIfExists(path.join(workdir, "business", "user_stories.md"));
  const checklistsPath = path.join(workdir, "business", "checklists.yaml");
  let checklists = "";
  try {
    if (fs.existsSync(checklistsPath)) {
      const doc = yaml.load(fs.readFileSync(checklistsPath, "utf8"));
      checklists = JSON.stringify(doc);
      if (checklists.length > 4000) checklists = checklists.slice(0, 4000);
    }
  } catch {}
  return {
    rules: rules.slice(0, 8000),
    userStories: userStories.slice(0, 8000),
    checklists
  };
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
   Azure LLM w/ Fallback + Plan Shaping
======================= */

// Few-shot example to force the shape (both keys present, arrays allowed to be empty)
const FEW_SHOT_EXAMPLE = {
  comments: [
    {
      path: "src/payments/PaymentSelector.tsx",
      line: 128,
      severity: "HIGH",
      title: "Multi-payment regression risk",
      body: "Business rule BR-12: default to last used method for users with >1 saved method. This change removes preferredPaymentId lookup; multi-method users will default to first item. Suggested fix: restore last-used lookup and fall back to explicit selection if null."
    }
  ],
  tests: [
    {
      language: "javascript",
      framework: "jest",
      path: "__tests__/neuron.generated.test.js",
      mode: "append_or_create",
      content: "// neuron generated test\n test('selects last used payment when multiple exist', () => { /* ... */ });"
    }
  ]
};

function ensurePlanShape(plan) {
  // Guardrail: if model forgets required top-level keys, add empty arrays
  if (plan == null || typeof plan !== "object") return { comments: [], tests: [] };
  if (!Array.isArray(plan.comments)) plan.comments = [];
  if (!Array.isArray(plan.tests)) plan.tests = [];
  return plan;
}

function extractFirstJsonObject(text) {
  const fence = text.indexOf("```");
  if (fence !== -1) {
    const fenceEnd = text.indexOf("```", fence + 3);
    const inside = fenceEnd !== -1 ? text.slice(fence + 3, fenceEnd) : text.slice(fence + 3);
    const braceStart = inside.indexOf("{");
    const braceEnd = inside.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
      return inside.slice(braceStart, braceEnd + 1);
    }
  }
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s !== -1 && e !== -1 && e > s) {
    return text.slice(s, e + 1);
  }
  return "";
}

async function getLLMPlanWithFallback(input) {
  const SYSTEM = [
    "You are Neuron, an expert reviewer who enforces product/business rules.",
    "Return ONLY valid JSON matching the provided JSON schema.",
    "Include BOTH top-level keys: comments (array) and tests (array).",
    "If you have nothing to say for one section, return an empty array for that section."
  ].join(" ");
  const schemaStr = JSON.stringify(JSON_SCHEMA);

  // Try strict JSON mode first
  try {
    const messages = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          ...input,
          json_schema: schemaStr,
          example: FEW_SHOT_EXAMPLE
        })
      }
    ];

    const resp = await openai.getChatCompletions(AZURE_OPENAI_DEPLOYMENT, messages, {
      temperature: 0.2,
      maxTokens: 1200,
      responseFormat: { type: "json_object" }
    });

    const content = resp.choices?.[0]?.message?.content || "";
    let plan = JSON.parse(content);
    plan = ensurePlanShape(plan);

    const valid = validatePlan(plan);
    if (!valid) {
      // One retry with explicit correction request
      const retry = await openai.getChatCompletions(
        AZURE_OPENAI_DEPLOYMENT,
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: "Your last output did not satisfy the schema. Produce ONLY a JSON object with keys comments:[] and tests:[] (arrays may be empty)." },
          { role: "user", content: JSON.stringify({ ...input, json_schema: schemaStr, example: FEW_SHOT_EXAMPLE }) }
        ],
        { temperature: 0.1, maxTokens: 1200, responseFormat: { type: "json_object" } }
      );
      const content2 = retry.choices?.[0]?.message?.content || "";
      plan = ensurePlanShape(JSON.parse(content2));
      if (!validatePlan(plan)) {
        return { plan: null, diag: { code: "SCHEMA_INVALID", detail: JSON.stringify(validatePlan.errors).slice(0, 500) } };
      }
    }
    return { plan, diag: { code: "OK_JSON_MODE" } };
  } catch (err) {
    DEBUG && console.warn("[warn] JSON mode failed; falling back:", err?.message || err);
  }

  // Retry WITHOUT JSON mode; then extract JSON from text
  try {
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ ...input, json_schema: JSON.stringify(JSON_SCHEMA), example: FEW_SHOT_EXAMPLE }) },
      { role: "system", content: "Return ONLY a JSON object with keys comments (array) and tests (array). Do not include any prose outside JSON." }
    ];

    const resp = await openai.getChatCompletions(AZURE_OPENAI_DEPLOYMENT, messages, {
      temperature: 0.1,
      maxTokens: 1400
    });
    const raw = resp.choices?.[0]?.message?.content || "";
    const candidate = extractFirstJsonObject(raw);
    if (!candidate) {
      return { plan: null, diag: { code: "JSON_MISSING", detail: (raw || "").slice(0, 350) } };
    }
    let plan = ensurePlanShape(JSON.parse(candidate));
    const valid = validatePlan(plan);
    if (!valid) {
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

/* =======================
   Plan Application
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

async function applyPlan(workdir, plan, ctx) {
  const { owner, repo, pr } = ctx;
  const written = [];
  const fpSet = new Set();

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

  // Commit & push
  if (written.length) {
    exec(`git -C "${workdir}" add ${written.map(w => `"${w}"`).join(" ")}`);
    exec(`git -C "${workdir}" -c user.email="neuron[bot]@example.com" -c user.name="Neuron Bot" commit -m "chore(neuron): add/update generated tests"`);
    exec(`git -C "${workdir}" push origin HEAD:${pr.head.ref}`);
  }

  // Comments (cap 3)
  const toPost = (plan.comments || []).slice(0, 3).filter(c => {
    const fp = `${c.path}:${c.line}:${c.title}`;
    if (fpSet.has(fp)) return false;
    fpSet.add(fp);
    return true;
  });

  if (toPost.length) {
    let body = `**Neuron — Business-context review**\n\n`;
    for (const c of toPost) {
      body += `- **${c.severity}** \`${c.path}:${c.line}\` — **${c.title}**\n\n  ${c.body}\n\n`;
    }
    if (written.length) {
      body += `**Generated/updated tests:**\n${written.map(w => `- \`${w}\``).join("\n")}\n`;
    }
    await postIssueComment(owner, repo, pr.number, body);
  }

  return { tests_written: written, comments_posted: toPost.length };
}

async function postSummary(_owner, _repo, _pull_number, _plan, _applied) {
  // Optional secondary summary; kept empty for now.
}

async function postIssueComment(owner, repo, issue_number, body) {
  try {
    await octokit.issues.createComment({ owner, repo, issue_number, body });
  } catch (e) {
    console.error("[error] Failed to post PR comment:", e);
  }
}
