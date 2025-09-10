import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [,, repoPath, rulesPath] = process.argv;
if (!repoPath || !rulesPath) {
  console.error("Usage: node analyzers/run-and-normalize.js <repoPath> <semgrepRulesPath>");
  process.exit(1);
}

// run semgrep to write the JSON
execSync(
  `semgrep --config "${rulesPath}" --json --error --output semgrep.json .`,
  { cwd: repoPath, stdio: "inherit" }
);

// normalize to findings.json
const normalizer = path.resolve("analyzers", "normalize-findings.js");
execSync(`node "${normalizer}" "${repoPath}"`, { stdio: "inherit" });

// prit the findings back for the server to read
const findings = fs.readFileSync(path.join(repoPath, "findings.json"), "utf8");
process.stdout.write(findings);
