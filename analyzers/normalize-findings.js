import fs from "fs";
import path from "path";

function mapSemgrep(sem) {
  const out = [];
  const results = sem?.results || [];
  for (const r of results) {
    const file =
      r.path || r?.location?.path || r?.extra?.path || "unknown";
    const start =
      r.start?.line ??
      r.extra?.location?.start?.line ??
      r?.start?.line ??
      1;
    const end =
      r.end?.line ??
      r.extra?.location?.end?.line ??
      start;
    const ruleId = r.check_id || r.rule_id || "unknown";
    const sev = String(r.extra?.severity || "info").toUpperCase();
    const msg = r.extra?.message || "Semgrep finding";
    out.push({
      tool: "semgrep",
      rule_id: String(ruleId),
      severity: ["CRITICAL","HIGH","MEDIUM","LOW","INFO"].includes(sev) ? sev : "INFO",
      file,
      start_line: Number(start),
      end_line: Number(end),
      title: msg.slice(0, 120),
      message: msg,
      fingerprint: `${file}:${start}:${ruleId}`
    });
  }
  return out;
}

const repoPath = process.argv[2];
if (!repoPath) {
  console.error("Usage: node normalize-findings.js <path-to-neuron-demo>");
  process.exit(1);
}

const semgrepPath = path.join(repoPath, "semgrep.json");
if (!fs.existsSync(semgrepPath)) {
  console.error(`semgrep.json not found at ${semgrepPath}. Run Semgrep first.`);
  process.exit(1);
}

const sem = JSON.parse(fs.readFileSync(semgrepPath, "utf8"));
const findings = mapSemgrep(sem);

const outPath = path.join(repoPath, "findings.json");
fs.writeFileSync(outPath, JSON.stringify(findings, null, 2));
console.log(`✅ Wrote ${outPath} with ${findings.length} findings`);
