// analyzers/run-and-normalize.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [,, repoPath, rulesPath] = process.argv;
if (!repoPath || !rulesPath) {
  console.error("Usage: node analyzers/run-and-normalize.js <repoPath> <semgrepRulesPath>");
  process.exit(1);
}

// Run semgrep (writes semgrep.json in the target repo folder)
execSync(
  `semgrep --config "${rulesPath}" --json --error --output semgrep.json .`,
  { cwd: repoPath, stdio: "inherit" }
);

// Normalize to findings.json using your existing script
const normalizer = path.resolve("analyzers", "normalize-findings.js");
execSync(`node "${normalizer}" "${repoPath}"`, { stdio: "inherit" });

// Print findings.json to stdout so index.js can JSON.parse it
const findings = fs.readFileSync(path.join(repoPath, "findings.json"), "utf8");
process.stdout.write(findings);
