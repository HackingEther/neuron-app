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

// Make sure Semgrep installed by pip is on PATH in Render
process.env.PATH = [
  process.env.PATH,
  "/opt/render/project/src/.venv/bin",
  "/opt/render/.cache/pipx/venvs/semgrep/bin",
  `${process.env.HOME || ""}/.local/bin`,
  `${process.env.HOME || ""}/.local/pipx/venvs/semgrep/bin`,
].filter(Boolean).join(":");

// (Optional) turn off Semgrep telemetry the supported way
process.env.SEMGREP_SEND_TELEMETRY = "0";

// Verify GitHub HMAC (sha256)
function verify(sigHeader, raw) {
  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

app.post("/webhook", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    if (!sig || !verify(sig, raw)) return res.status(401).send("Bad signature");

    const event = req.headers["x-github-event"];
    const payload = JSON.parse(raw.toString("utf8"));

    // Handle PR events that mean “rerun checks”
    if (event === "pull_request" && ["opened", "synchronize", "reopened"].includes(payload.action)) {
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNum = payload.number;

      const headRef = payload.pull_request.head.ref;                 // e.g. "feature/semgrep-demo"
      const headRepoFull = payload.pull_request.head.repo.full_name; // e.g. "HackingEther/neuron-demo"

      const octokit = new Octokit({ auth: GITHUB_TOKEN });

      // Start tracer
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNum,
        body: "🔧 Neuron: starting static checks…",
      });

      // Create temp working dir
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "neuron-"));
      const repoDir = path.join(work, "repo");

      try {
        // Shallow clone PR branch
        execSync(
          `git clone --depth 1 --branch "${headRef}" "https://github.com/${headRepoFull}.git" repo`,
          { cwd: work, stdio: "inherit" }
        );

        // Where to find the rules and wrapper (from the cloned repo)
        const rulesPath = path.join(repoDir, "semgrep.yml");
        const runScript = path.join(process.cwd(), "analyzers", "run-and-normalize.js");

        if (!fs.existsSync(rulesPath)) {
          throw new Error(
            `Missing semgrep rules at ${rulesPath}. Commit semgrep.yml to the PR branch.`
          );
        }
        if (!fs.existsSync(runScript)) {
          throw new Error(
            `Missing analyzer wrapper at ${runScript}. Ensure analyzers/run-and-normalize.js exists in neuron-app.`
          );
        }

        // Run the analyzer wrapper (this internally runs Semgrep, no --no-analytics flag used)
        const findingsJson = execSync(`node "${runScript}" "${repoDir}" "${rulesPath}"`, {
          encoding: "utf8",
        });
        const findings = JSON.parse(findingsJson); // array

        // --- Noise control: inline <=3, plus one summary ---
        const sorted = [...findings].sort((a, b) => {
          const sevOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
          return (sevOrder[b.severity] || 0) - (sevOrder[a.severity] || 0);
        });

        const topInline = sorted.slice(0, 3);
        const total = findings.length;

        // Inline comments
        for (const f of topInline) {
          try {
            await octokit.pulls.createReviewComment({
              owner,
              repo,
              pull_number: prNum,
              body: `**${f.severity}** \`${f.rule_id}\`: ${f.title}\n\n${f.message || ""}`,
              commit_id: payload.pull_request.head.sha,
              path: f.file,
              side: "RIGHT",
              line: f.start_line,
            });
          } catch (e) {
            // If inline anchor fails (e.g., line mapping), fall back to issue comment
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number: prNum,
              body: `🔎 **${f.severity}** \`${f.rule_id}\` in \`${f.file}\` @ L${f.start_line}\n${f.title}\n${f.message || ""}`,
            });
          }
        }

        // Summary comment
        const bullets =
          total === 0
            ? "No findings 🎉"
            : findings
                .slice(0, 5)
                .map(
                  (f) =>
                    `- **${f.severity}** \`${f.rule_id}\` in \`${f.file}\` @ L${f.start_line} — ${f.title}`
                )
                .join("\n");

        const body =
          total === 0
            ? "✅ Neuron: no issues found by Semgrep."
            : `🧠 **Neuron static checks (Semgrep)**\n\n**${total} finding(s)** (showing top 5):\n\n${bullets}\n\n_Noise control: posted up to 3 inline comments._`;

        await octokit.issues.createComment({ owner, repo, issue_number: prNum, body });
        console.log(`Posted analyzer results to PR #${prNum} in ${owner}/${repo}`);
      } catch (e) {
        console.error("Analyzer error:", e);
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNum,
          body: `⚠️ Neuron: analyzer failed.\n\n\`\`\`\n${String(e).slice(0, 2000)}\n\`\`\``,
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

app.get("/", (_, res) => res.send("Neuron webhook running"));
app.listen(PORT, () => console.log(`Neuron webhook listening on :${PORT}`));
