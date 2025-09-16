// analyzers/run-and-normalize.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoDir   = process.argv[2];
const rulesPath = process.argv[3];

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

let semgrepBin = "semgrep";
let semgrepVersion = "(version check failed)";
try { semgrepBin = run("which semgrep").trim(); } catch {}
try { semgrepVersion = run(`${semgrepBin} --version`).trim(); } catch {}

const dirtyEnv = { ...process.env };
const cleanEnv = { ...process.env };
for (const k of Object.keys(dirtyEnv)) if (/^SEMGREP_/i.test(k)) delete cleanEnv[k];
cleanEnv.SEMGREP_SEND_TELEMETRY = "0";
cleanEnv.SEMGREP_ENABLE_VERSION_CHECK = "0";

// IMPORTANT: no --error (that flag forces non-zero exit when findings exist)
const cmd = `${semgrepBin} scan --config "${rulesPath}" --json .`;

console.error("🔎 run-and-normalize diagnostics");
console.error(" repoDir:", repoDir);
console.error(" rulesPath:", rulesPath);
console.error(" semgrepBin:", semgrepBin);
console.error(" semgrepVersion:", semgrepVersion);
console.error(" removed SEMGREP_* keys:", Object.keys(dirtyEnv).filter(k => /^SEMGREP_/i.test(k)));
console.error(" finalCmd:", cmd);

function parseSemgrepJson(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

let rawJsonText = null;
try {
  rawJsonText = execSync(cmd, { cwd: repoDir, encoding: "utf8", env: cleanEnv });
} catch (e) {
  // Semgrep might exit non-zero but still print full JSON to stdout; try to use it.
  const stdout = e && e.stdout ? String(e.stdout) : "";
  const parsed = parseSemgrepJson(stdout);
  if (parsed) {
    rawJsonText = stdout;
  } else {
    console.error("❌ semgrep execution failed.");
    console.error("stderr:", e.stderr ? String(e.stderr) : "(no stderr)");
    console.error("stdout (non-JSON):", stdout.slice(0, 2000));
    throw e;
  }
}

// Optional: drop the raw semgrep output in the repo temp dir for inspection
try { fs.writeFileSync(path.join(repoDir, "semgrep.json"), rawJsonText, "utf8"); } catch {}

const raw = parseSemgrepJson(rawJsonText) || { results: [] };
const normalized = (raw.results || []).map(r => ({
  tool: "semgrep",
  rule_id: r.check_id,
  severity: r.extra?.severity || "INFO",
  file: r.path,
  start_line: r.start?.line,
  end_line: r.end?.line,
  title: r.extra?.message || "No message provided",
  metadata: r.extra || {},
}));

// Emit normalized results on stdout for index.js
console.log(JSON.stringify(normalized, null, 2));
