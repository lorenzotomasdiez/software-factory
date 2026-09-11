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

  return checks;
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

/**
 * Deterministic checks on the reviewer's synthesized report: long enough,
 * references more than one scout by title, and isn't just a near-duplicate
 * of a single scout's raw output (word-overlap heuristic, not an LLM judge).
 */
export function reviewerGates(report: string, scoutTitles: string[], scoutTexts: string[]): GateCheck[] {
  const checks: GateCheck[] = [];
  const trimmed = report.trim();

  checks.push({ name: "min_length", ok: trimmed.length >= 300, detail: `${trimmed.length} chars` });

  const lower = trimmed.toLowerCase();
  const cited = scoutTitles.filter((t) => lower.includes(t.toLowerCase()));
  checks.push({
    name: "cites_scouts",
    ok: cited.length >= Math.max(1, Math.ceil(scoutTitles.length / 2)),
    detail: `references ${cited.length}/${scoutTitles.length} scout titles`,
  });

  const maxSimilarity = Math.max(0, ...scoutTexts.map((t) => jaccardSimilarity(trimmed, t)));
  checks.push({
    name: "not_verbatim_copy",
    ok: maxSimilarity < 0.75,
    detail: `max word-overlap with a single scout: ${(maxSimilarity * 100).toFixed(0)}%`,
  });

  return checks;
}
