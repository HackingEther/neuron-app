// analyzers/normalize-findings.js
// ESM module (Node 22). Converts Semgrep's JSON to Neuron's unified schema.

function toUpperSafe(s, fallback) {
  if (!s) return fallback;
  try { return String(s).toUpperCase(); } catch { return fallback; }
}

function mapSemgrepSeverity(sev) {
  const s = toUpperSafe(sev, "MEDIUM");
  if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(s)) return s;
  // Semgrep sometimes returns "WARNING" etc; map to nearest.
  if (s === "WARNING") return "MEDIUM";
  if (s === "ERROR") return "HIGH";
  return "MEDIUM";
}

/**
 * Normalize a single Semgrep result into Neuron schema.
 * Semgrep shape reference:
 *  - result.check_id
 *  - result.path
 *  - result.start.line / result.end.line
 *  - result.extra.message
 *  - result.extra.severity
 *  - result.extra.metadata?.title / docs / category
 */
function normalizeSemgrepResult(r) {
  const ruleId = r?.check_id ?? "unknown";
  const engine = "semgrep";
  const title =
    r?.extra?.metadata?.title ||
    (r?.extra?.message ? String(r.extra.message).split("\n")[0] : ruleId);

  const meta = r?.extra?.metadata || {};
  const severity = mapSemgrepSeverity(r?.extra?.severity);

  return {
    id: `${engine}.${ruleId}`,
    engine,
    rule_id: ruleId,
    severity,
    file: r?.path || r?.extra?.path || "unknown",
    start_line: Number(r?.start?.line ?? 0) || 0,
    end_line: Number(r?.end?.line ?? r?.start?.line ?? 0) || 0,
    title,
    message: r?.extra?.message || title,
    metadata: {
      ruleCategory: meta.category ?? null,
      docs: meta.docs ?? null,
      raw: r?.extra ?? null
    }
  };
}

/**
 * Entry: normalize a whole Semgrep JSON object
 * Expected input: { results: [ ... ] }
 */
export function normalizeSemgrepJson(semgrepJson) {
  const results = Array.isArray(semgrepJson?.results) ? semgrepJson.results : [];
  return results.map(normalizeSemgrepResult);
}

// --- Optional CLI mode (useful for local debugging) ---
// node analyzers/normalize-findings.js /path/to/semgrep.json
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  const path = process.argv[2];
  const raw = fs.readFileSync(path, "utf8");
  const semgrepObj = JSON.parse(raw);
  const normalized = normalizeSemgrepJson(semgrepObj);
  process.stdout.write(JSON.stringify(normalized, null, 2));
}
