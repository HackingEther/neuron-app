// index.js — Neuron webhook (ESM)
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
const { WEBHOOK_SECRET, GITHUB_TOKEN, PORT = 3000 } = process.env;

// Help the container find semgrep if installed via pip in a venv/pipx
process.env.PATH = [
  process.env.PATH,
  "/opt/render/project/src/.venv/bin",
  "/opt/render/.cache/pipx/venvs/semgrep/bin",
  `${process.env.HOME || ""}/.local/bin`,
  `${process.env.HOME || ""}/.local/pipx/venvs/semgrep/bin`,
].filter(Boolean).join(":");

// --- utilities ---------------------------------------------------------------

function verifySignature(sigHeader, rawBody) {
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return sigHeader === expected;
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function short(s, n = 1500) {
  return String(s || "").slice(0, n);
}

// --- webhook ----------------------------------------------------------------

app.post("/webhook", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    if (!sig || !verifySignature(sig, raw)) {
      return res.status(401).send("Bad signature");
    }

    const event = req.headers["x-github-event"];
    const payload = safeJsonParse(raw.toString("utf8"), null);
    if (!payload) return res.status(400).send("Bad payload");

    if (
      event === "pull_request" &&
      ["opened", "synchronize", "reopened"].includes(payload.action)
    ) {
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNum = payload.number;
      const headRef = payload.pull_request.head.ref; // e.g. "test-branch"
      const headRepoFull = payload.pull_request.head.repo.full_name; // e.g. "HackingEther/neuron-demo"

      const octokit = new Octokit({ auth: GITHUB_TOKEN });

      // tracer comment so you know the run started
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNum,
        body: "🔧 Neuron: starting static checks…",
      });

      // temp workspace
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "neuron-"));
      const repoDir = path.join(work, "repo");

      try {
        // shallow clone the PR branch
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        // Prefer rules inside the target repo; fallback to service copy
        const repoRules = path.join(repoDir, "semgrep.yml");
        const serviceRules = path.resolve("semgrep.yml");
        const rulesPath = fs.existsSync(repoRules) ? repoRules : serviceRules;

        // Analyzer wrapper (ESM) that prints normalized ARRAY to stdout
        const runScript = path.resolve("analyzers", "run-and-normalize.js");
        if (!fs.existsSync(runScript)) {
          throw new Error(
            `Missing analyzer wrapper at ${runScript}. Create analyzers/run-and-normalize.js.`
          );
        }
        if (!fs.existsSync(rulesPath)) {
          throw new Error(
            `Missing semgrep rules at ${rulesPath}. Add a semgrep.yml to the repo root or service root.`
          );
        }

        // Execute analyzer
        const findingsJson = execSync(
          `node "${runScript}" "${repoDir}" "${rulesPath}"`,
          { encoding: "utf8" }
        );

        const findings = safeJsonParse(findingsJson, []);
        if (!Array.isArray(findings)) {
          throw new Error(
            `Analyzer returned a non-array. First 200 chars: ${short(
              findingsJson,
              200
            )}`
          );
        }

        // Build PR-level summary (show at most top 5 by severity/name)
        const SEV_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
        const sorted = findings
          .slice()
          .sort(
            (a, b) =>
              (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0)
          );

        const top = sorted.slice(0, 5);
        const lines = top.map((f) => {
          const where =
            f.file && f.start_line ? `\`${f.file}\` @ L${f.start_line}` : "";
          const rule = f.rule_id ? `\`${f.rule_id}\`` : "";
          const title = f.title || f.metadata?.message || "(no message)";
          return `- **${f.severity || "INFO"}** ${rule} ${where}\n  ${title}`;
        });

        const total = findings.length;
        const summaryBody =
          total === 0
            ? "✅ Neuron: no issues found by Semgrep."
            : `🧠 **Neuron static checks (Semgrep)**\n\n**${total} finding(s)**:\n\n${lines.join(
                "\n"
              )}\n\n_Source: \`semgrep.yml\` (${fs.existsSync(repoRules) ? "repo" : "service"} rules)._`;

        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNum,
          body: summaryBody,
        });

        console.log(
          `Posted analyzer summary to PR #${prNum} in ${owner}/${repo} (total findings: ${total})`
        );
      } catch (e) {
        console.error("Analyzer error:", e);
        const msg = short(e && e.stack ? e.stack : e, 1800);
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNum,
          body: `⚠️ Neuron: analyzer failed.\n\n\`\`\`\n${msg}\n\`\`\``,
        });
      } finally {
        // clean up
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

// Simple health check
app.get("/", (_, res) => res.send("Neuron webhook running"));

app.listen(PORT, () =>
  console.log(`Neuron webhook listening on :${PORT}`)
);
