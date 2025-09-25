// baseline.js
// Persist and consult a repo-local baseline to avoid repeating suggestions forever.
// We record (path, line, title) + the file's content SHA at time of suggestion.
// If the file hasn't changed, we skip resurfacing the same suggestion.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASELINE_PATH = ".neuron/baseline.json";

export function fileSha(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return "";
  }
}

export function ensureBaselineDir(workdir) {
  const dir = path.join(workdir, ".neuron");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readBaseline(workdir) {
  const abs = path.join(workdir, BASELINE_PATH);
  try {
    if (!fs.existsSync(abs)) return { suggestions: [] };
    const json = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (!Array.isArray(json.suggestions)) return { suggestions: [] };
    return json;
  } catch {
    return { suggestions: [] };
  }
}

export function writeBaseline(workdir, baseline) {
  ensureBaselineDir(workdir);
  const abs = path.join(workdir, BASELINE_PATH);
  fs.writeFileSync(abs, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

export function fpForComment(c) {
  // Stable fingerprint for a suggestion
  return `${c.path}:${c.line}:${c.title}`;
}

// Decide if we should skip a comment because we've already suggested it for the same file state.
export function shouldSkipComment(workdir, baseline, comment) {
  const fp = fpForComment(comment);
  const abs = path.join(workdir, comment.path);
  const sha = fileSha(abs);
  const found = baseline.suggestions.find(s => s.fp === fp);
  if (!found) return false; // never seen
  // If file SHA unchanged since we last suggested, skip it.
  return found.file_sha && sha && found.file_sha === sha;
}

// Update the baseline with newly posted comments.
export function recordComments(workdir, baseline, postedComments) {
  let changed = false;
  for (const c of postedComments) {
    const fp = fpForComment(c);
    const abs = path.join(workdir, c.path);
    const sha = fileSha(abs);
    const existing = baseline.suggestions.find(s => s.fp === fp);
    if (existing) {
      if (sha && existing.file_sha !== sha) {
        existing.file_sha = sha;
        existing.updated_at = new Date().toISOString();
        changed = true;
      }
    } else {
      baseline.suggestions.push({
        fp,
        path: c.path,
        file_sha: sha,
        first_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      changed = true;
    }
  }
  return changed;
}
