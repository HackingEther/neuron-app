#!/usr/bin/env node
/**
 * ESM version — works with "type":"module".
 * Accepts Semgrep exit 0/1; fails on >=2; prints { findings: [...] } to stdout.
 * Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

const [, , repoDirArg, rulesPathArg] = process.argv;
if (!repoDirArg || !rulesPathArg) {
  die("Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>");
}

const repoDir = path.resolve(repoDirArg);
const rulesPath = path.resolve(rulesPathArg);

if (!fs.existsSync(repoDir)) die(`Repo dir not found: ${repoDir}`);
if (!fs.existsSync(rulesPath)) die(`Rules file not found: ${rulesPath}`);

const outFile = path.join(repoDir, "semgrep.json");

// No "--error" flag. We only want JSON and an output file.
const semArgs = ["--config", rulesPath, "--json", "--output", outFile, "."];
const sem = spawnSync("semgrep", semArgs, { cwd: repoDir, encoding: "utf8" });

if (sem.error) die(`Failed to start semgrep: ${sem.error.message}`);

// 0 = no matches, 1 = matches, >=2 = real error
if (typeof sem.status === "number" && sem.status >= 2) {
  const stderr = (sem.stderr || "").slice(0, 4000);
  die(`Semgrep failed (exit ${sem.status}). stderr:\n${stderr}`);
}

// Ensure JSON exists (fallback to stdout in older versions)
if (!fs.existsSync(outFile)) {
  const stdout = sem.stdout || "";
  if (stdout.trim().startsWith("{")) {
    try { fs.writeFileSync(outFile, stdout, "utf8"); }
    catch (e) { die(`Could not write semgrep.json from stdout: ${e.message}`); }
  } else {
    fs.writeFileSync(outFile, JSON.stringify({ results: [] }), "utf8");
  }
}

// Normalize to unified shape
let raw;
try { raw = JSON.parse(fs.readFileSync(outFile, "utf8")); }
catch (e) { die(`Could not parse semgrep.json: ${e.message}`); }

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

process.stdout.write(JSON.stringify({ findings }));
