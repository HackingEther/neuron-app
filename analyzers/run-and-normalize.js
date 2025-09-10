#!/usr/bin/env node
/**
 * Run Semgrep on a repo and print a unified findings JSON to stdout.
 * Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>
 *
 * Exits 0 on success (even if findings exist). Exits 2+ on real errors.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

const [,, repoDirArg, rulesPathArg] = process.argv;
if (!repoDirArg || !rulesPathArg) {
  die("Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>");
}

const repoDir = path.resolve(repoDirArg);
const rulesPath = path.resolve(rulesPathArg);

if (!fs.existsSync(repoDir)) die(`Repo dir not found: ${repoDir}`);
if (!fs.existsSync(rulesPath)) die(`Rules file not found: ${rulesPath}`);

const outFile = path.join(repoDir, "semgrep.json");

// Run semgrep. Accept exit codes 0 (no findings) and 1 (findings). Fail on >=2.
const semArgs = ["--config", rulesPath, "--json", "--output", outFile, "."];
// Note: no "--error" flag; we only care about real CLI failures.
const sem = spawnSync("semgrep", semArgs, { cwd: repoDir, encoding: "utf8" });

if (sem.error) {
  die(`Failed to start semgrep: ${sem.error.message}`);
}

// Non-zero statuses:
// 0 = no matches; 1 = matches; >=2 = actual error
if (typeof sem.status === "number" && sem.status >= 2) {
  // Include some stderr context for debugging
  die(`Semgrep failed (exit ${sem.status}). stderr:\n${(sem.stderr || "").slice(0, 4000)}`);
}

// Ensure output file exists even if there were no findings.
if (!fs.existsSync(outFile)) {
  // Some very old semgrep versions only printed to stdout; fallback to that.
  const stdout = sem.stdout || "";
  if (stdout.trim().startsWith("{")) {
    try {
      fs.writeFileSync(outFile, stdout, "utf8");
    } catch (e) {
      die(`Could not write semgrep.json from stdout: ${e.message}`);
    }
  } else {
    // No JSON produced; treat as empty results.
    fs.writeFileSync(outFile, JSON.stringify({ results: [] }), "utf8");
  }
}

// Read semgrep JSON and normalize
let raw;
try {
  raw = JSON.parse(fs.readFileSync(outFile, "utf8"));
} catch (e) {
  die(`Could not parse semgrep.json: ${e.message}`);
}

// Semgrep JSON shape: { results: [ { check_id, path, start, end, extra: { message, severity, ... } } ] }
const results = Array.isArray(raw?.results) ? raw.results : [];
const findings = results.map((r) => ({
  ruleId: r.check_id || r.id || "unknown-rule",
  severity: r?.extra?.severity || "INFO",
  path: r.path || r?.extra?.metadata?.file || "unknown",
  start: { line: r?.start?.line ?? null, col: r?.start?.col ?? null },
  end:   { line: r?.end?.line ?? null,   col: r?.end?.col ?? null },
  message: r?.extra?.message || "",
  title: r?.extra?.metadata?.shortDescription || r?.extra?.message || "",
  metadata: r?.extra?.metadata || {},
}));

// Print unified JSON to stdout for index.js to consume
const unified = { findings };
process.stdout.write(JSON.stringify(unified));
