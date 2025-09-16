import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";

import { execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// --- Azure OpenAI (Foundry) ---
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";

dotenv.config();

const app = express();
const {
  WEBHOOK_SECRET,
  GITHUB_TOKEN,
  PORT = 3000,

  // Azure OpenAI bits (set these in Render)
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY,
  AZURE_OPENAI_DEPLOYMENT,      // e.g. "neuron-llm"
  AZURE_OPENAI_API_VERSION = "2024-02-01"
} = process.env;

// Prepare Azure client if configured
let aoaiClient = null;
if (AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY) {
  try {
    aoaiClient = new OpenAIClient(
      AZURE_OPENAI_ENDPOINT,
      new AzureKeyCredential(AZURE_OPENAI_KEY),
      { apiVersion: AZURE_OPENAI_API_VERSION }
    );
  } catch (e) {
    console.error("Failed to construct Azure OpenAI client:", e);
  }
}

// (Optional) help Render/Linux find semgrep if it's installed via pipx
process.env.PATH = [
  process.env.PATH,
  "/opt/render/.cache/pipx/venvs/semgrep/bin",
  `${process.env.HOME || ""}/.local/bin`,
  `${process.env.HOME || ""}/.local/pipx/venvs/semgrep/bin`,
].filter(Boolean).join(":");

// Verify webhook HMAC signature (proves request is from GitHub)
function verify(sigHeader, raw) {
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

// Utility: get list of changed files (quick summary for LLM)
function extractChangedFiles(payload) {
  const pr = payload.pull_request;
  const files = [];
  // We don’t have the full file list in this payload;
  // include head/base refs for context instead.
  files.push(`base: ${pr.base.ref} @ ${pr.base.sha.slice(0,7)}`);
  files.push(`head: ${pr.head.ref} @ ${pr.head.sha.slice(0,7)}`);
  return files;
}

// Utility: call Azure OpenAI to produce a short “Neuron Test Plan”
async function generateTestPlan({ repoFull, prNum, files, findings }) {
  // Build a compact context for the model
  const findingsBullets = (findings || []).slice(0, 5).map(f =>
    `• [${f.severity}] ${f.rule_id} in ${f.file}:L${f.start_line} — ${f.title}`
  ).join("\n");

  const sys = [
    "You are Neuron, a senior QA engineer.",
    "You generate concise test plans tailored to a PR.",
    "Focus on business-risk coverage, not generic unit tests.",
    "Output 3–5 bullet points. Prefer plain steps and expected checks.",
  ].join(" ");

  const user = [
    `Repository: ${repoFull}`,
    `PR #${prNum}`,
    `Changed refs:\n${files.map(f => `- ${f}`).join("\n")}`,
    findings && findings.length ? `\nStatic findings:\n${findingsBullets}` : "\nStatic findings: none",
    "\nProduce a short 'Neuron Test Plan' with 3–5 bullets. Keep it under 120 words."
  ].join("\n");

  if (!aoaiClient || !AZURE_OPENAI_DEPLOYMENT) {
    // Fallback text if Azure isn’t configured fully
    return {
      ok: false,
      text: "ℹ️ LLM not configured (missing endpoint/key/deployment). Skipping test plan.",
    };
  }

  try {
    const resp = await aoaiClient.getChatCompletions(
      AZURE_OPENAI_DEPLOYMENT,
      [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      { temperature: 0.2, maxTokens: 220 }
    );
    const choice = resp?.choices?.[0]?.message?.content?.trim();
    if (choice) {
      return { ok: true, text: choice };
    }
    return { ok: false, text: "LLM returned no content." };
  } catch (e) {
    console.error("Azure OpenAI call failed:", e?.message || e);
    return { ok: false, text: `LLM error: ${String(e).slice(0, 300)}` };
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    if (!sig || !verify(sig, raw)) return res.status(401).send("Bad signature");

    const event = req.headers["x-github-event"];
    const payload = JSON.parse(raw.toString("utf8"));

    if (event === "pull_request" && ["opened", "synchronize", "reopened"].includes(payload.action)) {
      const owner = payload.repository.owner.login;
      const repo  = payload.repository.name;
      const repoFull = payload.repository.full_name;
      const prNum = payload.number;

      const headRef = payload.pull_request.head.ref;                 // e.g. "test-branch"
      const headRepoFull = payload.pull_request.head.repo.full_name; // e.g. "HackingEther/neuron-demo"

      const octokit = new Octokit({ auth: GITHUB_TOKEN });

      // tracer comment so you know the run started
      await octokit.issues.createComment({
        owner, repo, issue_number: prNum,
        body: "🔧 Neuron: starting static checks…"
      });

      // temp workspace
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "neuron-"));
      const repoDir = path.join(work, "repo");

      let findings = [];
      try {
        // shallow clone the PR branch
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        // prefer repo-level semgrep.yml if present, else fallback to our server copy
        const repoRules = path.join(repoDir, "semgrep.yml");
        const serverRules = path.resolve("semgrep.yml");
        const rulesPath = fs.existsSync(repoRules) ? repoRules : serverRules;

        // analyzer wrapper
        const runScript = path.resolve("analyzers", "run-and-normalize.js");
        if (!fs.existsSync(runScript)) {
          throw new Error(`Missing analyzer wrapper at ${runScript}. Create analyzers/run-and-normalize.js.`);
        }
        if (!fs.existsSync(rulesPath)) {
          throw new Error(`Missing semgrep rules at ${rulesPath}. Add a semgrep.yml to repo or server root.`);
        }

        // run semgrep and normalize to canonical findings[]
        const findingsJson = execSync(
          `node "${runScript}" "${repoDir}" "${rulesPath}"`,
          { encoding: "utf8" }
        );
        const parsed = JSON.parse(findingsJson);
        findings = Array.isArray(parsed) ? parsed : [];

        // Build a short PR-level summary
        const total = findings.length;
        const top = findings.slice(0, 5).map(f =>
          `- **${f.severity}** \`${f.rule_id}\` in \`${f.file}\` @ L${f.start_line}\n  ${f.title}`
        ).join("\n");

        const staticBody = total === 0
          ? "✅ Neuron: no issues found by Semgrep."
          : `🧠 **Neuron static checks (Semgrep)**\n\n**${total} finding(s)**:\n\n${top}\n\n_Artifact generated server-side: \`findings.json\`._`;

        await octokit.issues.createComment({ owner, repo, issue_number: prNum, body: staticBody });
        console.log(`Posted analyzer summary to PR #${prNum} in ${owner}/${repo}`);
      } catch (e) {
        console.error("Analyzer error:", e);
        await octokit.issues.createComment({
          owner, repo, issue_number: prNum,
          body: `⚠️ Neuron: analyzer failed.\n\n\`\`\`\n${String(e).slice(0, 1500)}\n\`\`\``
        });
      } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      }

      // --- LLM: Neuron Test Plan ---
      try {
        const files = extractChangedFiles(payload);
        const plan = await generateTestPlan({
          repoFull,
          prNum,
          files,
          findings
        });

        const llmComment = plan.ok
          ? `🧪 **Neuron Test Plan (LLM)**\n\n${plan.text}`
          : `ℹ️ **Neuron LLM step**\n\n${plan.text}`;

        await octokit.issues.createComment({
          owner, repo, issue_number: prNum, body: llmComment
        });
        console.log("Posted LLM test plan");
      } catch (e) {
        console.error("LLM step failed:", e);
        await octokit.issues.createComment({
          owner, repo, issue_number: prNum,
          body: `⚠️ Neuron: LLM step failed.\n\n\`\`\`\n${String(e).slice(0, 800)}\n\`\`\``
        });
      }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

// Simple GET endpoint for health checks
app.get("/", (_, res) => res.send("Neuron webhook running"));

app.listen(PORT, () => console.log(`Neuron webhook listening on :${PORT}`));
