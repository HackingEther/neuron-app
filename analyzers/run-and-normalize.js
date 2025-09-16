// analyzers/run-and-normalize.js (ESM)
// Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , repoDir, rulesPath] = process.argv;

function fail(msg, details = "") {
  const out = [msg, details].filter(Boolean).join("\n");
  console.error(out);
  process.exit(2);
}

if (!repoDir || !rulesPath) {
  fail("Usage: node analyzers/run-and-normalize.js <repoDir> <rulesPath>");
}

if (!fs.existsSync(repoDir)) {
  fail(`Repo dir not found: ${repoDir}`);
}
if (!fs.existsSync(rulesPath)) {
  fail(`Rules file not found: ${rulesPath}`);
}

// Prefer using the semgrep installed on the box; PATH is set in index.js
const semgrepArgs = [
  "--config", rulesPath,
  "--json",
  "--no-analytics",
  "--timeout", "120",
  // keep noise down / avoid huge scans in demos
  "--exclude", "node_modules",
  "--exclude", ".git",
  "--skip-unknown-extensions",
  "--quiet",
];

const res = spawnSync("semgrep", semgrepArgs, {
  cwd: repoDir,
  encoding: "utf8",
});

// Semgrep exit codes can be quirky across versions.
// We treat exit codes 0 or 1 as usable if stdout contains JSON.
// (Some versions used non-zero for “findings present” when paired with flags.)
const code = typeof res.status === "number" ? res.status : res.signal || -1;

let semgrepJson;
try {
  semgrepJson = JSON.parse(res.stdout || "{}");
} catch (e) {
  // If we couldn't parse JSON, then it’s a real failure.
  fail(
    `Semgrep produced non-JSON output (exit ${code}).`,
    (res.stderr || "").slice(0, 4000)
  );
}

if ((code !== 0 && code !== 1) && !semgrepJson.results) {
  fail(
    `Semgrep failed (exit ${code}).`,
    (res.stderr || "").slice(0, 4000)
  );
}

// Normalize to Neuron’s unified shape (array of findings)
const results = Array.isArray(semgrepJson.results) ? semgrepJson.results : [];

const normalized = results.map(r => {
  // Semgrep fields we care about
  const file = r.path || r.extra?.path || r.extra?.location?.path || "unknown";
  const start = r.start || r.extra?.start || {};
  const end = r.end || r.extra?.end || {};
  const ruleId = r.check_id || r.id || r.rule_id || "unknown-rule";
  const severity = r.extra?.severity || r.severity || "INFO";
  const message = r.extra?.message || r.message || r.extra?.metadata?.message || "";

  return {
    tool: "semgrep",
    rule_id: ruleId,
    severity,
    title: message,
    file,
    start_line: start.line ?? 0,
    end_line: end.line ?? start.line ?? 0,
    metadata: {
      message,
      fix: r.extra?.metadata?.fix ?? null,
      references: r.extra?.metadata?.references ?? [],
      metavars: r.extra?.metavars ?? undefined,
    },
  };
});

// Print ONLY the normalized array to stdout (index.js reads this)
process.stdout.write(JSON.stringify(normalized));
