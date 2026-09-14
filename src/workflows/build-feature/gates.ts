import { extractJson, type GateCheck } from "../scout-context/gates";

export { extractJson, type GateCheck };

export interface PlanStep {
  id: string;
  description: string;
  refs: string[];
  files?: string[];
}
export interface PlannerEnvelope {
  steps: PlanStep[];
}

export interface DesignEntry {
  stepId: string;
  approach: string;
  files?: string[];
}
export interface ArchitectEnvelope {
  design: DesignEntry[];
}

export interface DeveloperEnvelope {
  filesChanged: string[];
  summary: string;
}

export interface TesterEnvelope {
  testsAdded: string[];
  summary: string;
}

export type CoverageStatus = "done" | "partial" | "missing";
export interface CoverageEntry {
  id: string;
  status: CoverageStatus;
  note: string;
}
export interface ReviewerEnvelope {
  summary: string;
  coverage: CoverageEntry[];
  readyForReview: boolean;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function isPlannerEnvelope(value: unknown): value is PlannerEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.steps) || v.steps.length === 0) return false;
  return v.steps.every((s) => {
    if (!s || typeof s !== "object") return false;
    const step = s as Record<string, unknown>;
    return (
      typeof step.id === "string" &&
      step.id.trim().length > 0 &&
      typeof step.description === "string" &&
      step.description.trim().length > 0 &&
      isStringArray(step.refs) &&
      (step.files === undefined || isStringArray(step.files))
    );
  });
}

/** Deterministic checks on the planner's step breakdown - no model grades quality here. */
export function plannerGates(raw: unknown, mustCoverIds: string[]): GateCheck[] {
  const checks: GateCheck[] = [];
  const shapeOk = isPlannerEnvelope(raw);
  checks.push({ name: "envelope_shape", ok: shapeOk, detail: shapeOk ? `${(raw as PlannerEnvelope).steps.length} step(s)` : "missing/malformed steps[]" });
  if (!shapeOk) return checks;

  const plan = raw as PlannerEnvelope;
  const ids = plan.steps.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  checks.push({ name: "unique_ids", ok: dupes.length === 0, detail: dupes.length === 0 ? "all step IDs unique" : `duplicate id(s): ${[...new Set(dupes)].join(", ")}` });

  const missingRefs = plan.steps.filter((s) => s.refs.length === 0);
  checks.push({ name: "has_refs", ok: missingRefs.length === 0, detail: missingRefs.length === 0 ? "every step references a spec item" : `step(s) with no refs: ${missingRefs.map((s) => s.id).join(", ")}` });

  const referenced = new Set(plan.steps.flatMap((s) => s.refs));
  const uncovered = mustCoverIds.filter((id) => !referenced.has(id));
  checks.push({
    name: "coverage",
    ok: uncovered.length === 0,
    detail: uncovered.length === 0 ? "every requirement/acceptance item is addressed by a step" : `no step addresses: ${uncovered.join(", ")}`,
  });

  return checks;
}

export function isArchitectEnvelope(value: unknown): value is ArchitectEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.design) || v.design.length === 0) return false;
  return v.design.every((d) => {
    if (!d || typeof d !== "object") return false;
    const entry = d as Record<string, unknown>;
    return typeof entry.stepId === "string" && typeof entry.approach === "string" && entry.approach.trim().length > 0;
  });
}

/** Deterministic checks on the architect's design - must cover every planned step. */
export function architectGates(raw: unknown, planStepIds: string[]): GateCheck[] {
  const checks: GateCheck[] = [];
  const shapeOk = isArchitectEnvelope(raw);
  checks.push({ name: "envelope_shape", ok: shapeOk, detail: shapeOk ? `${(raw as ArchitectEnvelope).design.length} entrie(s)` : "missing/malformed design[]" });
  if (!shapeOk) return checks;

  const covered = new Set((raw as ArchitectEnvelope).design.map((d) => d.stepId));
  const missing = planStepIds.filter((id) => !covered.has(id));
  checks.push({
    name: "covers_all_steps",
    ok: missing.length === 0,
    detail: missing.length === 0 ? `all ${planStepIds.length} plan step(s) have a design entry` : `no design for step(s): ${missing.join(", ")}`,
  });

  return checks;
}

export function isDeveloperEnvelope(value: unknown): value is DeveloperEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isStringArray(v.filesChanged) && typeof v.summary === "string" && v.summary.trim().length > 0;
}

function normalizePath(p: string): string {
  return p.trim().toLowerCase().replace(/^\.\//, "");
}

/**
 * Deterministic checks on the developer's turn - the real signal is the
 * actual git diff and a real build command run by the harness, never the
 * agent's self-report. `claims_backed` catches a developer claiming to have
 * changed a file it never touched (same self-consistency idea as
 * scout-context/spec-context's "no invented" checks).
 */
export function developerGates(raw: unknown, actualDiffFiles: string[], buildOk: boolean): GateCheck[] {
  const checks: GateCheck[] = [];
  const shapeOk = isDeveloperEnvelope(raw);
  checks.push({ name: "envelope_shape", ok: shapeOk, detail: shapeOk ? "parses" : "missing/malformed filesChanged[] or summary" });

  checks.push({ name: "build_passes", ok: buildOk, detail: buildOk ? "build command exited 0" : "build command failed" });
  checks.push({ name: "non_empty_diff", ok: actualDiffFiles.length > 0, detail: actualDiffFiles.length > 0 ? `${actualDiffFiles.length} file(s) changed` : "no changes against base branch" });

  if (shapeOk) {
    const actual = new Set(actualDiffFiles.map(normalizePath));
    const invented = (raw as DeveloperEnvelope).filesChanged.filter((f) => !actual.has(normalizePath(f)));
    checks.push({
      name: "claims_backed",
      ok: invented.length === 0,
      detail: invented.length === 0 ? "every claimed file actually changed" : `claimed but not in the real diff: ${invented.join(", ")}`,
    });
  }

  return checks;
}

export function isTesterEnvelope(value: unknown): value is TesterEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isStringArray(v.testsAdded) && typeof v.summary === "string";
}

/** The only check that actually matters here is mechanical: the real test command's exit code. */
export function testerGates(raw: unknown, testOk: boolean): GateCheck[] {
  const shapeOk = isTesterEnvelope(raw);
  return [
    { name: "envelope_shape", ok: shapeOk, detail: shapeOk ? "parses" : "missing/malformed testsAdded[] or summary" },
    { name: "tests_pass", ok: testOk, detail: testOk ? "test command exited 0" : "test command failed" },
  ];
}

const KNOWN_STATUSES: CoverageStatus[] = ["done", "partial", "missing"];

export function isReviewerEnvelope(value: unknown): value is ReviewerEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string" || typeof v.readyForReview !== "boolean" || !Array.isArray(v.coverage)) return false;
  return v.coverage.every((c) => {
    if (!c || typeof c !== "object") return false;
    const entry = c as Record<string, unknown>;
    return typeof entry.id === "string" && KNOWN_STATUSES.includes(entry.status as CoverageStatus) && typeof entry.note === "string";
  });
}

/**
 * Deterministic checks on the final reviewer - the model that wrote no code
 * here is auditing coverage of the ORIGINAL spec ids, and its readyForReview
 * verdict is cross-checked against the harness's own mechanical build/test
 * results so an LLM can never rubber-stamp a broken build as ready.
 */
export function reviewerGates(raw: unknown, allSpecIds: string[], buildOk: boolean, testOk: boolean): GateCheck[] {
  const checks: GateCheck[] = [];
  const shapeOk = isReviewerEnvelope(raw);
  checks.push({ name: "envelope_shape", ok: shapeOk, detail: shapeOk ? "parses" : "missing/malformed summary, coverage[], or readyForReview" });
  if (!shapeOk) return checks;

  const reviewer = raw as ReviewerEnvelope;
  const covered = new Set(reviewer.coverage.map((c) => c.id));
  const missing = allSpecIds.filter((id) => !covered.has(id));
  checks.push({
    name: "full_coverage",
    ok: missing.length === 0,
    detail: missing.length === 0 ? `all ${allSpecIds.length} spec item(s) accounted for` : `not covered: ${missing.join(", ")}`,
  });

  const mechanicalOk = buildOk && testOk;
  checks.push({
    name: "verdict_consistent",
    ok: mechanicalOk || reviewer.readyForReview === false,
    detail: mechanicalOk
      ? "mechanical gates passed - reviewer's verdict is its own to make"
      : reviewer.readyForReview === false
        ? "build/tests failed and reviewer correctly reported not ready"
        : "build and/or tests failed but reviewer claimed readyForReview: true",
  });

  return checks;
}

export function allSpecIds(spec: Record<string, { id: string }[]>): string[] {
  return Object.values(spec).flatMap((items) => items.map((i) => i.id));
}
