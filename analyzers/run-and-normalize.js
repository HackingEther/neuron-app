import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoDir = process.argv[2];
const rulesPath = process.argv[3];

// Build Semgrep command without --no-analytics
const semgrepCmd = `semgrep scan --config "${rulesPath}" --json --error .`;

const semgrepJson = execSync(semgrepCmd, {
  cwd: repoDir,
  encoding: "utf8",
  env: {
    ...process.env,
    SEMGREP_SEND_TELEMETRY: "0",
    SEMGREP_ENABLE_VERSION_CHECK: "0",
  },
});

// Save findings.json
const findingsPath = path.join(repoDir, "semgrep.json");
fs.writeFileSync(findingsPath, semgrepJson, "utf8");

// Normalize into consistent array of objects
const rawFindings = JSON.parse(semgrepJson);
const normalized = (rawFindings.results || []).map((r) => ({
  rule_id: r.check_id,
  severity: r.extra?.severity || "INFO",
  file: r.path,
  start_line: r.start?.line,
  end_line: r.end?.line,
  title: r.extra?.message || "No message provided",
  metadata: r.extra || {},
}));

console.log(JSON.stringify(normalized, null, 2));
