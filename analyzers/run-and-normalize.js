// analyzers/run-and-normalize.js
// ESM module. Runs Semgrep, then normalizes results to unified schema and prints to stdout.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSemgrepJson } from "./normalize-findings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function which(cmd) {
  try { return execSync(`which ${cmd}`, { encoding: "utf8" }).trim(); }
  catch { return null; }
}

function getSemgrepBin() {
  // Prefer explicit env, then venv path (Render), then PATH
  const hints = [
    process.env.SEMGREP_BIN,
    path.join(process.cwd(), ".venv/bin/semgrep"),
    "/opt/render/project/src/.venv/bin/semgrep",
    which("semgrep")
  ].filter(Boolean);
  return hints.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || "semgrep";
}

function readJsonSafe(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function logDiag(diag) {
  // minimal, non-noisy diagnostics (printed to stderr)
  console.error("🔎 run-and-normalize diagnostics");
  Object.entries(diag).forEach(([k, v]) => console.error(` ${k}: ${v}`));
}

async function main() {
  const repoDir = process.argv[2];
  const rulesPath = process.argv[3];

  if (!repoDir || !rulesPath) {
    console.error("Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>");
    process.exit(2);
  }

  const semgrepBin = getSemgrepBin();
  let semgrepVersion = "unknown";
  try {
    semgrepVersion = execSync(`${semgrepBin} --version`, { encoding: "utf8" }).trim();
  } catch {}

  const cmd = `${semgrepBin} scan --config "${rulesPath}" --json --error .`;

  logDiag({
    repoDir,
    rulesPath,
    semgrepBin,
    semgrepVersion,
    removedEnvKeys: Object.keys(process.env).filter(k => k.startsWith("SEMGREP_")).length
  });

  // Run Semgrep in the repo
  let semgrepJsonObj;
  try {
    const stdout = execSync(cmd, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // If semgrep printed JSON, parse from stdout
    semgrepJsonObj = JSON.parse(stdout);
  } catch (e) {
    // Sometimes semgrep writes JSON to stdout but still exits non-zero (rare).
    // Try to parse whatever we captured; otherwise bubble the error.
    const out = e?.stdout?.toString?.() || "";
    if (out.trim().startsWith("{")) {
      try {
        semgrepJsonObj = JSON.parse(out);
      } catch {
        console.error("❌ semgrep execution failed.");
        throw e;
      }
    } else {
      console.error("❌ semgrep execution failed.");
      throw e;
    }
  }

  const normalized = normalizeSemgrepJson(semgrepJsonObj);

  // Print ONLY normalized array to stdout (index.js consumes this)
  process.stdout.write(JSON.stringify(normalized));
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
