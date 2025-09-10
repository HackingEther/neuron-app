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

// Make sure semgrep is on PATH in Render/Linux images
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

// Safe getter for analyzer output: accept either an array or { findings: [...] }
function coerceFindingsShape(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.findings)) return parsed.findings;
  // handle raw semgrep.json if someone prints it by mistake
  if (parsed && Array.isArray(parsed.results)) {
    return parsed.results.map((r) => ({
      ruleId: r.check_id,
      severity: r?.extra?.severity,
      path: r.path,
      start: { line: r?.start?.line, col: r?.start?.col },
      end:   { line: r?.end?.line,   col: r?.end?.col },
      message: r?.extra?.message,
      title: r?.extra?.metadata?.shortDescription || r?.extra?.message
    }));
  }
  return [];
}

// Normalize a single finding into display-friendly fields, tolerating multiple shapes
function normalizeForSummary(f) {
  const ruleId = f.rule_id ?? f.ruleId ?? f.id ?? f.check_id ?? "unknown-rule";
  const severity = f.severity ?? f?.extra?.severity ?? "INFO";
  const file = f.file ?? f.path ?? f?.location?.file ?? "unknown";
  const startLine =
    f.start_line ?? f?.start?.line ?? f?.location?.start?.line ?? null;
  const title =
    f.title ?? f.message ?? f?.extra?.message ?? "Issue detected";

  return { ruleId, severity, file, startLine, title };
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

      try {
        // shallow clone the PR branch (repo can be public; if private, use a PAT in the URL)
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        // Paths to rules and wrapper script (in neuron-app)
        const rulesPath = path.resolve("semgrep.yml");
        const runScript = path.resolve("analyzers", "run-and-normalize.js");

        if (!fs.existsSync(rulesPath)) {
          throw new Error(`Missing semgrep rules at ${rulesPath}. Add a semgrep.yml to repo root.`);
        }
        if (!fs.existsSync(runScript)) {
          throw new Error(`Missing analyzer wrapper at ${runScript}. Create analyzers/run-and-normalize.js.`);
        }

        // Run analyzer wrapper (prints unified JSON to stdout)
        const findingsJson = execSync(
          `node "${runScript}" "${repoDir}" "${rulesPath}"`,
          { encoding: "utf8" }
        );

        // Tolerate array OR { findings: [...] }
        const findingsArr = coerceFindingsShape(findingsJson);

        // Build a short PR-level summary
        const total = findingsArr.length;
        const top = findingsArr.slice(0, 5)
          .map((fRaw) => {
            const f = normalizeForSummary(fRaw);
            return `- **${f.severity}** \`${f.ruleId}\` in \`${f.file}\` @ L${f.startLine}\n  ${f.title}`;
          })
          .join("\n");

        const body = total === 0
          ? "✅ Neuron: no issues found by Semgrep."
          : `🧠 **Neuron static checks (Semgrep)**\n\n**${total} finding(s)**:\n\n${top}\n\n_Artifact generated server-side via Semgrep._`;

        await octokit.issues.createComment({ owner, repo, issue_number: prNum, body });
        console.log(`Posted analyzer summary to PR #${prNum} in ${owner}/${repo}`);
      } catch (e) {
        console.error("Analyzer error:", e);
        await octokit.issues.createComment({
          owner, repo, issue_number: prNum,
          body: `⚠️ Neuron: analyzer failed.\n\n\`\`\`\n${String(e).slice(0, 1500)}\n\`\`\``
        });
      } finally {
        // clean up temp directory
        try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
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
