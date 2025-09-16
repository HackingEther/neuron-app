// index.js — Neuron webhook + static analyzer + LLM test-plan generator (mockable)

import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";

import { execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const app = express();
const {
  WEBHOOK_SECRET,
  GITHUB_TOKEN,
  PORT = 3000,

  // LLM toggles — leave USE_AZURE_OPENAI=false to use the deterministic mock
  USE_AZURE_OPENAI = "false",
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_KEY
} = process.env;

// Help Render/Linux find semgrep if it's inside a venv
process.env.PATH = [
  process.env.PATH,
  "/opt/render/.cache/pipx/venvs/semgrep/bin",
  "/opt/render/project/src/.venv/bin",
  `${process.env.HOME || ""}/.local/bin`,
  `${process.env.HOME || ""}/.local/pipx/venvs/semgrep/bin`
]
  .filter(Boolean)
  .join(":");

// ---------- Webhook signature ----------
function verify(sigHeader, raw) {
  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

// ---------- Utilities ----------
function sortFindings(findings) {
  const sevRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return [...(Array.isArray(findings) ? findings : [])].sort(
    (a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0)
  );
}

function formatSummary(findings, cap = 5) {
  const sorted = sortFindings(findings);
  const top = sorted.slice(0, cap);
  if (top.length === 0) return "✅ Neuron: no issues found by analyzer.";
  const lines = top
    .map(
      (f) =>
        `- **${f.severity || "UNK"}** \`${f.rule_id || "rule"}\` in \`${f.file || "?"}\` @ L${
          f.start_line ?? "?"
        }\n  ${f.title || f.message || ""}`
    )
    .join("\n");
  return `🧠 **Neuron static checks**\n\n**${findings.length} finding(s)**:\n\n${lines}\n\n_Artifact generated server-side: \`findings.json\`._`;
}

// Fetch PR file list + patches (diff hunks)
async function fetchPrFiles(octokit, owner, repo, prNum) {
  const files = await octokit.pulls.listFiles({ owner, repo, pull_number: prNum, per_page: 100 });
  return files.data.map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: f.patch || "",
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes
  }));
}

// ---------- LLM providers ----------

// Deterministic mock LLM: turns findings+diffs into a small test plan
function mockGenerateTestPlan({ repoFullName, prNumber, baseRef, headRef, files, findings }) {
  const header = `# Neuron Test Plan\n\n**Repo:** ${repoFullName}\n**PR:** #${prNumber} (${headRef} → ${baseRef})\n\n`;
  const hasFindings = Array.isArray(findings) && findings.length > 0;

  const bulletsFromFindings = (findings || []).slice(0, 5).map((f, i) => {
    const file = f.file || "unknown file";
    const line = f.start_line ?? "?";
    const hint =
      f.rule_id?.includes("regex") || f.title?.toLowerCase().includes("regex")
        ? "Include very long, repetitive inputs to probe catastrophic backtracking."
        : f.rule_id?.includes("off-by-one") || /off[- ]?by[- ]?one/i.test(f.title || "")
        ? "Add tests for empty arrays and single-element arrays."
        : f.rule_id?.includes("null") || /null|undefined/i.test(f.title || "")
        ? "Add tests where inputs are null/undefined and ensure guards/optional chaining are present."
        : "Add boundary and adversarial cases informed by this finding.";
    return `- [ ] **${f.rule_id || f.title || "Analyzer finding"}** in \`${file}\` (L${line}) → ${hint}`;
  });

  // If no findings, derive generic tests from changed files
  const genericTests =
    files && files.length > 0
      ? files.slice(0, 5).map((f) => {
          const name = f.filename;
          const isJs = name.endsWith(".js") || name.endsWith(".ts");
          const suggestion = isJs
            ? "Add happy-path + error-path unit tests; include null/empty inputs and large inputs."
            : "Add a simple unit/integration test covering the change.";
          return `- [ ] \`${name}\`: ${suggestion}`;
        })
      : ["- [ ] Touch a file so CI picks up at least one changed path."];

  const outline = [
    "## Suggested Tests",
    ...(hasFindings ? bulletsFromFindings : genericTests),
    "",
    "## Notes",
    "- This plan is mock-generated (no external LLM).",
    "- When Azure OpenAI is enabled, these bullets will be refined with natural-language reasoning and repository context."
  ].join("\n");

  return header + outline + "\n";
}

// (Optional) Azure OpenAI provider — stubbed wiring point
async function azureGenerateTestPlan(input) {
  // Guard: ensure creds exist
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_DEPLOYMENT || !AZURE_OPENAI_API_KEY) {
    throw new Error("Azure OpenAI env vars missing; cannot call provider.");
  }
  // Minimal example with fetch (keep as placeholder; real prompt engineering later)
  const prompt = `
You are Neuron, an AI code reviewer. Create a concise test plan (3–6 bullets)
for the following PR context and analyzer findings. Prefer business-aware tests.

PR files (filename + patch snippet):
${(input.files || [])
  .slice(0, 5)
  .map((f) => `- ${f.filename}\n${f.patch?.slice(0, 600) || ""}`)
  .join("\n")}

Findings (JSON):
${JSON.stringify(input.findings || []).slice(0, 4000)}
`.trim();

  // NOTE: This is a placeholder; Azure's exact REST shape varies by API version.
  // You can replace with @azure/openai SDK if you prefer.
  const resp = await fetch(
    `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are a precise, terse test planner for PRs." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      })
    }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Azure OpenAI error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    "# Neuron Test Plan\n\n(Provider returned no content.)\n";
  // Ensure a header for consistency
  return text.startsWith("# Neuron") ? text : `# Neuron Test Plan\n\n${text}`;
}

// Upsert a file in the PR head branch
async function upsertFileInBranch(octokit, { owner, repo, branch, pathInRepo, content, message }) {
  // Get current file SHA if it exists
  let sha;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: pathInRepo,
      ref: branch
    });
    // Only set sha if file actually exists (not a directory)
    if (Array.isArray(existing.data)) {
      throw new Error(`${pathInRepo} is a directory, expected a file`);
    }
    sha = existing.data.sha;
  } catch (e) {
    // 404 → create new file
    sha = undefined;
  }

  const res = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: pathInRepo,
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    sha
  });
  return res.status;
}

// ---------- Webhook ----------
app.post("/webhook", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    if (!sig || !verify(sig, raw)) return res.status(401).send("Bad signature");

    const event = req.headers["x-github-event"];
    const payload = JSON.parse(raw.toString("utf8"));

    if (event === "pull_request" && ["opened", "synchronize", "reopened"].includes(payload.action)) {
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNum = payload.number;
      const baseRef = payload.pull_request.base.ref;
      const headRef = payload.pull_request.head.ref;
      const headRepoFull = payload.pull_request.head.repo.full_name; // e.g. user/repo

      const octokit = new Octokit({ auth: GITHUB_TOKEN });

      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNum,
        body: "🔧 Neuron: starting static checks…"
      });

      // Workspace
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "neuron-"));
      const repoDir = path.join(work, "repo");

      let findings = [];
      try {
        // Clone the PR HEAD
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        // Determine rules path: prefer repo's own semgrep.yml; fallback to server copy if present
        const repoRules = path.join(repoDir, "semgrep.yml");
        const serverRules = path.resolve("semgrep.yml");
        const rulesPath = fs.existsSync(repoRules)
          ? repoRules
          : fs.existsSync(serverRules)
          ? serverRules
          : null;

        if (!rulesPath) {
          throw new Error(
            `No semgrep.yml found in PR repo or server. Add one to the repo root or to server root.`
          );
        }

        // Analyzer wrapper
        const runScriptRepo = path.join(repoDir, "analyzers", "run-and-normalize.js");
        const runScriptServer = path.resolve("analyzers", "run-and-normalize.js");
        const runScript = fs.existsSync(runScriptRepo) ? runScriptRepo : runScriptServer;

        if (!fs.existsSync(runScript)) {
          throw new Error(
            `Missing analyzer wrapper at ${runScript}. Ensure analyzers/run-and-normalize.js exists.`
          );
        }

        // Run analyzer
        const findingsJson = execSync(`node "${runScript}" "${repoDir}" "${rulesPath}"`, {
          encoding: "utf8"
        });
        findings = JSON.parse(findingsJson);

        // Post analyzer summary (top-5)
        const summary = formatSummary(findings, 5);
        await octokit.issues.createComment({ owner, repo, issue_number: prNum, body: summary });

        // ====== LLM TEST PLAN STAGE ======
        // Gather PR file diffs for context
        const files = await fetchPrFiles(octokit, owner, repo, prNum);

        // Choose provider
        const useAzure = USE_AZURE_OPENAI.toLowerCase() === "true";
        let testPlanMd;
        try {
          if (useAzure) {
            testPlanMd = await azureGenerateTestPlan({
              repoFullName: `${owner}/${repo}`,
              prNumber: prNum,
              baseRef,
              headRef,
              files,
              findings
            });
          } else {
            testPlanMd = mockGenerateTestPlan({
              repoFullName: `${owner}/${repo}`,
              prNumber: prNum,
              baseRef,
              headRef,
              files,
              findings
            });
          }
        } catch (llmErr) {
          // Fall back to mock if Azure fails
          console.error("LLM provider failed, falling back to mock:", llmErr);
          testPlanMd =
            mockGenerateTestPlan({
              repoFullName: `${owner}/${repo}`,
              prNumber: prNum,
              baseRef,
              headRef,
              files,
              findings
            }) + `\n> Provider error: ${String(llmErr).slice(0, 400)}\n`;
        }

        // Upsert NEURON_TEST_PLAN.md in PR head branch
        await upsertFileInBranch(octokit, {
          owner,
          repo,
          branch: headRef,
          pathInRepo: "NEURON_TEST_PLAN.md",
          content: testPlanMd,
          message: "chore(neuron): update NEURON_TEST_PLAN.md from webhook"
        });

        // Also post as a PR comment (handy for demo)
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNum,
          body: `🧪 **Neuron Test Plan (auto-generated)**\n\n${testPlanMd}`
        });

        console.log(`Posted analyzer summary + test plan to PR #${prNum} (${owner}/${repo})`);
      } catch (e) {
        console.error("Analyzer/LLM error:", e);
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNum,
          body: `⚠️ Neuron: analyzer/LLM stage failed.\n\n\`\`\`\n${String(e).slice(0, 1500)}\n\`\`\``
        });
      } finally {
        try {
          fs.rmSync(work, { recursive: true, force: true });
        } catch {}
      }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

// Health check
app.get("/", (_, res) => res.send("Neuron webhook running"));

app.listen(PORT, () => console.log(`Neuron webhook listening on :${PORT}`));
