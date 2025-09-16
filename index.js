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

// Help the container find semgrep if installed via pip/pipx
process.env.PATH = [
  process.env.PATH,
  "/opt/render/.venv/bin",
  "/opt/render/.cache/pipx/venvs/semgrep/bin",
  `${process.env.HOME || ""}/.local/bin`,
  `${process.env.HOME || ""}/.local/pipx/venvs/semgrep/bin`,
].filter(Boolean).join(":");

// Verify webhook signature from GitHub
function verify(sigHeader, raw) {
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

// Prefer project rules, fall back to service defaults
function discoverRules(repoDir) {
  const repoRulesDir = path.join(repoDir, ".neuron", "rules");
  const repoSemgrep = path.join(repoDir, "semgrep.yml");
  const serviceDefault = path.resolve("rules", "default.yml");

  if (fs.existsSync(repoRulesDir)) {
    const files = fs.readdirSync(repoRulesDir)
      .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();
    if (files.length) {
      const chosen = path.join(repoRulesDir, files[0]);
      return { chosen, source: ".neuron/rules/*" };
    }
  }
  if (fs.existsSync(repoSemgrep)) {
    return { chosen: repoSemgrep, source: "repo/semgrep.yml" };
  }
  if (fs.existsSync(serviceDefault)) {
    return { chosen: serviceDefault, source: "service rules/default.yml" };
  }
  return { chosen: null, source: "none" };
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

      const headRef = payload.pull_request.head.ref;
      const headRepoFull = payload.pull_request.head.repo.full_name;

      const octokit = new Octokit({ auth: GITHUB_TOKEN });

      await octokit.issues.createComment({
        owner, repo, issue_number: prNum,
        body: "🔧 Neuron: starting static checks…"
      });

      const work = fs.mkdtempSync(path.join(os.tmpdir(), "neuron-"));
      const repoDir = path.join(work, "repo");

      try {
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        const { chosen: rulesPath, source } = discoverRules(repoDir);
        if (!rulesPath) {
          throw new Error(`No rules found (looked for .neuron/rules/*.yml, repo/semgrep.yml, and service rules/default.yml).`);
        }
        console.log(`Using rules: ${rulesPath} (source: ${source})`);

        const runScript = path.resolve("analyzers", "run-and-normalize.js");
        if (!fs.existsSync(runScript)) {
          throw new Error(`Missing analyzer wrapper at ${runScript}. Create analyzers/run-and-normalize.js.`);
        }

        const findingsJson = execSync(
          `node "${runScript}" "${repoDir}" "${rulesPath}"`,
          { encoding: "utf8" }
        );

        let findings = [];
        try {
          findings = JSON.parse(findingsJson);
        } catch (err) {
          throw new Error(`Analyzer did not return valid JSON: ${err}\nRaw:\n${findingsJson.slice(0, 1000)}`);
        }

        const total = Array.isArray(findings) ? findings.length : 0;
        const top = (Array.isArray(findings) ? findings : []).slice(0, 5).map(f =>
          `- **${f.severity}** \`${f.rule_id}\` in \`${f.file}\` @ L${f.start_line}\n  ${f.title}`
        ).join("\n");

        const relToRepo = path.relative(repoDir, rulesPath);
        const relDisplay = relToRepo.startsWith("..")
          ? path.relative(process.cwd(), rulesPath)
          : relToRepo;

        const body = total === 0
          ? `✅ Neuron: no issues found by Semgrep.\n\nRuleset: \`${relDisplay}\` (${source}).`
          : `🧠 **Neuron static checks (Semgrep)**\n\n**${total} finding(s)**:\n\n${top}\n\nRuleset: \`${relDisplay}\` (${source}).\n_Artifact: unified \`findings.json\` generated server-side._`;

        await octokit.issues.createComment({ owner, repo, issue_number: prNum, body });
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
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

app.get("/", (_, res) => res.send("Neuron webhook running"));

app.listen(PORT, () => console.log(`Neuron webhook listening on :${PORT}`));
