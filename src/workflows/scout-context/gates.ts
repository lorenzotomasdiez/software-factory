import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ScoutEnvelope {
  summary: string;
  findings: string[];
  files: string[];
}

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function extractJson(text: string): unknown {
  let candidate = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) candidate = fenceMatch[1];
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in output");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function isScoutEnvelope(value: unknown): value is ScoutEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    Array.isArray(v.findings) &&
    v.findings.every((f) => typeof f === "string") &&
    Array.isArray(v.files) &&
    v.files.every((f) => typeof f === "string")
  );
}

/**
 * Deterministic, mechanical checks on a scout's envelope - no model grades
 * another model's work here. Mirrors sssf's gate philosophy: verify what the
 * envelope CLAIMS, never guess at quality.
 */
export function scoutGates(raw: unknown, cwd: string): GateCheck[] {
  const checks: GateCheck[] = [];

  const shapeOk = isScoutEnvelope(raw);
  checks.push({
    name: "envelope_shape",
    ok: shapeOk,
    detail: shapeOk ? "parses" : "missing/malformed summary, findings[], or files[]",
  });
  if (!shapeOk) return checks;

  const envelope = raw as ScoutEnvelope;
  checks.push({
    name: "non_trivial",
    ok: envelope.summary.trim().length >= 40 && envelope.findings.length >= 1,
    detail: `summary ${envelope.summary.length} chars, ${envelope.findings.length} finding(s)`,
  });

  const missing = envelope.files.filter((f) => !existsSync(join(cwd, f)));
  checks.push({
    name: "files_exist",
    ok: missing.length === 0,
    detail: missing.length === 0 ? `all ${envelope.files.length} file(s) exist` : `does not exist: ${missing.join(", ")}`,
  });

  const undeclared = findingsPathMismatch(envelope.findings, envelope.files);
  checks.push({
    name: "findings_consistent",
    ok: undeclared.length === 0,
    detail:
      undeclared.length === 0
        ? "every file path mentioned in findings is listed in files[]"
        : `findings mention path(s) missing from files[]: ${undeclared.join(", ")}`,
  });

  return checks;
}

/** Path-looking tokens: a slash-or-dot-separated segment ending in a short extension. */
const PATH_TOKEN = /\b[\w][\w./-]*\.[a-zA-Z]{1,10}\b/g;

function extractPathTokens(text: string): string[] {
  return [...text.matchAll(PATH_TOKEN)].map((m) => m[0]);
}

/**
 * Self-consistency check (mirrors sssf's `verdict_consistent`): does the
 * envelope contradict itself, not "is it right." A scout that writes
 * "src/foo/bar.ts does X" in its findings but never lists bar.ts under
 * files[] is making an unbacked claim the harness can catch without
 * reading a line of the file.
 */
function findingsPathMismatch(findings: string[], files: string[]): string[] {
  const declared = new Set(files.map((f) => f.toLowerCase()));
  const mentioned = new Set<string>();
  for (const finding of findings) {
    for (const token of extractPathTokens(finding)) mentioned.add(token.toLowerCase());
  }
  return [...mentioned].filter((token) => !declared.has(token) && ![...declared].some((f) => f.endsWith(token) || token.endsWith(f)));
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ScoutForGate {
  angle: string;
  files: string[];
}

/**
 * Deterministic checks on the reviewer's synthesized report: long enough,
 * actually draws on more than one scout's own file citations (not just
 * whichever scout happens to share the most vocabulary with the topic),
 * isn't just a near-duplicate of a single scout's raw output (word-overlap
 * heuristic, not an LLM judge), and doesn't invent file paths no scout
 * actually reported (self-consistency against the source material it was
 * given, same idea as sssf's `verdict_consistent`).
 *
 * `cites_scouts` checks concrete file paths rather than title text: the
 * reviewer is never instructed to reuse a scout's exact heading, so matching
 * on paraphrase-able prose was a false-positive machine. A file path is a
 * claim it either backs or doesn't.
 */
export function reviewerGates(report: string, scoutTexts: string[], scouts: ScoutForGate[]): GateCheck[] {
  const checks: GateCheck[] = [];
  const trimmed = report.trim();
  const reportPaths = new Set(extractPathTokens(trimmed).map((p) => p.toLowerCase()));

  checks.push({ name: "min_length", ok: trimmed.length >= 300, detail: `${trimmed.length} chars` });

  // Only scouts that actually declared a file can be "cited" this way - a
  // scout with an empty files[] isn't a gap in the reviewer's work.
  const citable = scouts.filter((s) => s.files.length > 0);
  const covered = citable.filter((s) => s.files.some((f) => reportPaths.has(f.toLowerCase())));
  checks.push({
    name: "cites_scouts",
    ok: citable.length === 0 || covered.length >= Math.max(1, Math.ceil(citable.length / 2)),
    detail:
      citable.length === 0
        ? "no scout declared a citable file - skipped"
        : `cites a file from ${covered.length}/${citable.length} scout(s) with files: ${covered.map((s) => s.angle).join(", ") || "none"}`,
  });

  const maxSimilarity = Math.max(0, ...scoutTexts.map((t) => jaccardSimilarity(trimmed, t)));
  checks.push({
    name: "not_verbatim_copy",
    ok: maxSimilarity < 0.75,
    detail: `max word-overlap with a single scout: ${(maxSimilarity * 100).toFixed(0)}%`,
  });

  const allFiles = scouts.flatMap((s) => s.files);
  const invented = findingsPathMismatch([trimmed], allFiles);
  checks.push({
    name: "no_invented_files",
    ok: invented.length === 0,
    detail:
      invented.length === 0
        ? "every file path in the report traces back to a scout"
        : `report mentions path(s) no scout reported: ${invented.join(", ")}`,
  });

  return checks;
}
