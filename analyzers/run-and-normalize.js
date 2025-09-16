// analyzers/run-and-normalize.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoDir   = process.argv[2];
const rulesPath = process.argv[3];

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

// 1) Discover semgrep binary + version
let semgrepBin = "semgrep";
try { semgrepBin = sh("which semgrep").trim(); } catch {}
let semgrepVersion = "(version check failed)";
try { semgrepVersion = sh(`${semgrepBin} --version`).trim(); } catch {}

// 2) Build a *clean* environment: strip any SEMGREP_* that could inject flags
const dirtyEnv = { ...process.env };
const cleanEnv = { ...process.env };
for (const k of Object.keys(dirtyEnv)) {
  if (/^SEMGREP_/i.test(k)) delete cleanEnv[k];
}
// Set only safe knobs explicitly
cleanEnv.SEMGREP_SEND_TELEMETRY = "0";
cleanEnv.SEMGREP_ENABLE_VERSION_CHECK = "0";

// 3) Compose the command (NOTE: no --no-analytics here)
const cmd = `${semgrepBin} scan --config "${rulesPath}" --json --error .`;

// 4) Emit diagnostics to stderr so they show up if we fail
console.error("🔎 run-and-normalize diagnostics");
console.error(" repoDir:", repoDir);
console.error(" rulesPath:", rulesPath);
console.error(" semgrepBin:", semgrepBin);
console.error(" semgrepVersion:", semgrepVersion);
console.error(" removed SEMGREP_* keys:", Object.keys(dirtyEnv).filter(k => /^SEMGREP_/i.test(k)));
console.error(" finalCmd:", cmd);

let semgrepJson;
try {
  // 5) Run semgrep in the repo with the CLEAN env
  semgrepJson = execSync(cmd, { cwd: repoDir, encoding: "utf8", env: cleanEnv });
} catch (e) {
  // If it still claims --no-analytics, something outside env is wrapping the binary.
  console.error("❌ semgrep execution failed.");
  console.error("stderr:", e.stderr ? String(e.stderr) : "(no stderr)");
  console.error("stdout:", e.stdout ? String(e.stdout) : "(no stdout)");
  throw e; // let index.js bubble this up into the PR comment
}

// (optional) save raw output for debugging on the ephemeral FS
try { fs.writeFileSync(path.join(repoDir, "semgrep.json"), semgrepJson, "utf8"); } catch {}

const raw = JSON.parse(semgrepJson);
const normalized = (raw.results || []).map(r => ({
  rule_id: r.check_id,
  severity: r.extra?.severity || "INFO",
  file: r.path,
  start_line: r.start?.line,
  end_line: r.end?.line,
  title: r.extra?.message || "No message provided",
  metadata: r.extra || {},
}));

// Emit normalized results to stdout for index.js to consume
console.log(JSON.stringify(normalized, null, 2));
