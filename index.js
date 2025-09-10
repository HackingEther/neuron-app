import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";

// ⬇️ added: we'll shell out to git/semgrep and manage temp dirs
import { execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const app = express();
const { WEBHOOK_SECRET, GITHUB_TOKEN, PORT = 3000 } = process.env;

// (Optional) help Render/Linux find semgrep if it's installed via pipx
// You can tweak or remove these, they're safe no-ops on Windows if not present.
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
        // shallow clone the PR branch
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        // run semgrep + normalize, capture JSON to stdout
        // Requires:
        //  - semgrep.yml at project root
        //  - analyzers/run-and-normalize.js (wraps semgrep + normalize-findings.js)
        const rulesPath = path.resolve("semgrep.yml");
        const runScript = path.resolve("analyzers", "run-and-normalize.js");

        // sanity check helpful errors
        if (!fs.existsSync(rulesPath)) {
          throw new Error(`Missing semgrep rules at ${rulesPath}. Add a semgrep.yml to repo root.`);
        }
        if (!fs.existsSync(runScript)) {
          throw new Error(`Missing analyzer wrapper at ${runScript}. Create analyzers/run-and-normalize.js.`);
        }

        const findingsJson = execSync(
          `node "${runScript}" "${repoDir}" "${rulesPath}"`,
          { encoding: "utf8" }
        );
        const findings = JSON.parse(findingsJson);

        // Build a short PR-level summary
        const total = findings.length;
        const top = findings.slice(0, 5).map(f =>
          `- **${f.severity}** \`${f.rule_id}\` in \`${f.file}\` @ L${f.start_line}\n  ${f.title}`
        ).join("\n");

        const body = total === 0
          ? "✅ Neuron: no issues found by Semgrep."
          : `🧠 **Neuron static checks (Semgrep)**\n\n**${total} finding(s)**:\n\n${top}\n\n_Artifact generated server-side: \`findings.json\`._`;

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
