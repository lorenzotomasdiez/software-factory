import { extractJson, type GateCheck } from "../scout-context/gates";

export { extractJson, type GateCheck };

export const KNOWN_SECTIONS = ["requirements", "interfaces", "constraints", "acceptance", "edge_cases"] as const;
export type SectionName = (typeof KNOWN_SECTIONS)[number];

export interface SpecItem {
  id: string;
  text: string;
  refs?: string[];
}

export interface SectionEnvelope {
  section: SectionName;
  items: SpecItem[];
}

export interface PlannerEnvelope {
  sections: SectionName[];
}

export interface ReviewerOutput {
  markdown: string;
  spec: Partial<Record<SectionName, SpecItem[]>>;
}

function isKnownSection(value: unknown): value is SectionName {
  return typeof value === "string" && (KNOWN_SECTIONS as readonly string[]).includes(value);
}

export function isPlannerEnvelope(value: unknown): value is PlannerEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.sections) && v.sections.length > 0 && v.sections.every(isKnownSection);
}

function isSpecItem(value: unknown): value is SpecItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.trim().length > 0 &&
    typeof v.text === "string" &&
    v.text.trim().length > 0 &&
    (v.refs === undefined || (Array.isArray(v.refs) && v.refs.every((r) => typeof r === "string")))
  );
}

export function isSectionEnvelope(value: unknown): value is SectionEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isKnownSection(v.section) &&
    Array.isArray(v.items) &&
    v.items.length > 0 &&
    v.items.every(isSpecItem)
  );
}

function isReviewerOutput(value: unknown): value is ReviewerOutput {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.markdown !== "string" || !v.spec || typeof v.spec !== "object") return false;
  const spec = v.spec as Record<string, unknown>;
  return Object.entries(spec).every(([key, items]) => isKnownSection(key) && Array.isArray(items) && items.every(isSpecItem));
}

/** Deterministic, mechanical check on the planner's chosen section list. */
export function plannerGates(raw: unknown): GateCheck[] {
  const ok = isPlannerEnvelope(raw);
  return [
    {
      name: "envelope_shape",
      ok,
      detail: ok ? `sections: ${(raw as PlannerEnvelope).sections.join(", ")}` : "missing/malformed sections[] (must be non-empty, from the known set)",
    },
  ];
}

/**
 * Deterministic, mechanical checks on one section agent's envelope - no
 * model grades another model's work here. Mirrors scout-context's gate
 * philosophy: verify what the envelope CLAIMS, never guess at quality.
 */
export function sectionGates(raw: unknown, expectedSection: SectionName): GateCheck[] {
  const checks: GateCheck[] = [];

  const shapeOk = isSectionEnvelope(raw);
  checks.push({
    name: "envelope_shape",
    ok: shapeOk,
    detail: shapeOk ? `${(raw as SectionEnvelope).items.length} item(s)` : "missing/malformed section or items[]",
  });
  if (!shapeOk) return checks;

  const envelope = raw as SectionEnvelope;
  checks.push({
    name: "correct_section",
    ok: envelope.section === expectedSection,
    detail: `expected "${expectedSection}", got "${envelope.section}"`,
  });

  const ids = envelope.items.map((i) => i.id);
  const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  checks.push({
    name: "unique_ids",
    ok: dupes.length === 0,
    detail: dupes.length === 0 ? "all item IDs unique" : `duplicate id(s): ${[...new Set(dupes)].join(", ")}`,
  });

  // Sections that trace back to earlier work must actually reference
  // something; requirements/interfaces/constraints are allowed to stand
  // alone since they're the foundation other sections point back to.
  if (expectedSection === "acceptance" || expectedSection === "edge_cases") {
    const missingRefs = envelope.items.filter((i) => !i.refs || i.refs.length === 0);
    checks.push({
      name: "has_refs",
      ok: missingRefs.length === 0,
      detail: missingRefs.length === 0 ? "every item references at least one other id" : `item(s) with no refs: ${missingRefs.map((i) => i.id).join(", ")}`,
    });
  }

  return checks;
}

function allIds(spec: Partial<Record<SectionName, SpecItem[]>>): Set<string> {
  const ids = new Set<string>();
  for (const items of Object.values(spec)) for (const item of items ?? []) ids.add(item.id);
  return ids;
}

/**
 * Deterministic checks on the lead reviewer's merged spec - mirrors
 * scout-context's `verdict_consistent`/`no_invented_files` philosophy: catch
 * the reviewer contradicting its OWN input/output, never grade quality.
 */
export function reviewerGates(raw: unknown, sourceSections: SectionEnvelope[]): GateCheck[] {
  const checks: GateCheck[] = [];

  const shapeOk = isReviewerOutput(raw);
  checks.push({ name: "envelope_shape", ok: shapeOk, detail: shapeOk ? "parses" : "missing/malformed markdown or spec{}" });
  if (!shapeOk) return checks;

  const reviewer = raw as ReviewerOutput;
  checks.push({
    name: "min_length",
    ok: reviewer.markdown.trim().length >= 300,
    detail: `${reviewer.markdown.trim().length} chars`,
  });

  const outputIds = allIds(reviewer.spec);
  const sourceIds = new Set(sourceSections.flatMap((s) => s.items.map((i) => i.id)));
  const dropped = [...sourceIds].filter((id) => !outputIds.has(id));
  checks.push({
    name: "coverage",
    ok: dropped.length === 0,
    detail: dropped.length === 0 ? `all ${sourceIds.size} source item(s) carried through` : `dropped without a trace: ${dropped.join(", ")}`,
  });

  const invalidRefs: string[] = [];
  for (const items of Object.values(reviewer.spec)) {
    for (const item of items ?? []) {
      for (const ref of item.refs ?? []) {
        if (!outputIds.has(ref)) invalidRefs.push(`${item.id}->${ref}`);
      }
    }
  }
  checks.push({
    name: "no_dangling_refs",
    ok: invalidRefs.length === 0,
    detail: invalidRefs.length === 0 ? "every ref resolves to a real item" : `dangling ref(s): ${invalidRefs.join(", ")}`,
  });

  const acceptance = reviewer.spec.acceptance ?? [];
  const untraced = acceptance.filter((a) => !a.refs || a.refs.length === 0);
  checks.push({
    name: "acceptance_traces_requirements",
    ok: acceptance.length === 0 || untraced.length === 0,
    detail: untraced.length === 0 ? "every acceptance item traces to at least one other item" : `untraced acceptance item(s): ${untraced.map((a) => a.id).join(", ")}`,
  });

  return checks;
}
