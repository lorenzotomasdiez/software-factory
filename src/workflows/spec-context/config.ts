import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../../home";
import type { SectionName } from "./gates";

export const WORKFLOW_DIR = join(ROOT_DIR, "workflows", "spec-context");
export const PROMPTS_DIR = join(WORKFLOW_DIR, "prompts");
export const RUNS_DIR = join(WORKFLOW_DIR, "runs");
export const CONFIG_FILE = join(WORKFLOW_DIR, "config.json");

export interface ModelRef {
  provider: string;
  model: string;
}

/** A name pointing at a provider+model pair in `models`, e.g. "deepseek" or "opus". */
export type ModelKey = string;

export interface AgentSpec {
  role: string;
  modelKey: ModelKey;
  promptFile: string; // relative to PROMPTS_DIR
}

export interface SectionAgentSpec extends AgentSpec {
  section: SectionName;
}

export interface SpecContextConfig {
  retries: number;
  models: Record<ModelKey, ModelRef>;
  planner: AgentSpec;
  sections: SectionAgentSpec[];
  reviewer: AgentSpec;
}

const DEFAULT_CONFIG: SpecContextConfig = {
  retries: 1,
  models: {
    // Every provider/model string below is editable - point these at whatever
    // is actually wired up in your pi config. The only rule this workflow
    // depends on: keep `reviewer` pointed at a model no `sections[]` entry
    // (or the planner) also uses, so the merge step isn't graded by the same
    // model that wrote (some of) the material it's merging.
    luna: { provider: "openai-codex", model: "gpt-5.6-luna" },
    deepseek: { provider: "openrouter", model: "deepseek/deepseek-v3.2" },
    sonnet: { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    opus: { provider: "openrouter", model: "anthropic/claude-opus-5" },
    // Kimi subscription (OAuth-logged in pi), not pay-per-token OpenRouter.
    kimi: { provider: "kimi-coding", model: "k3" },
    gemini: { provider: "openrouter", model: "google/gemini-3.8-flash" },
  },
  // Planning which sections apply is low cognitive load - cheap/fast model.
  planner: { role: "planner", modelKey: "luna", promptFile: "planner.md" },
  sections: [
    { section: "requirements", role: "section-requirements", modelKey: "deepseek", promptFile: "requirements.md" },
    { section: "interfaces", role: "section-interfaces", modelKey: "opus", promptFile: "interfaces.md" },
    { section: "constraints", role: "section-constraints", modelKey: "sonnet", promptFile: "constraints.md" },
    { section: "acceptance", role: "section-acceptance", modelKey: "kimi", promptFile: "acceptance.md" },
    { section: "edge_cases", role: "section-edge-cases", modelKey: "luna", promptFile: "edge-cases.md" },
  ],
  reviewer: { role: "reviewer", modelKey: "gemini", promptFile: "reviewer.md" },
};

const ID_RULES = (prefix: string) => `- Give each item a short stable id, e.g. "${prefix}1", "${prefix}2".`;

const TAIL = (section: string, example: string) =>
  [
    "- Be concrete and specific to this task, not generic advice.",
    "- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:",
    `\`\`\`json\n{"section": "${section}", "items": [${example}]}\n\`\`\``,
  ].join("\n");

const DEFAULT_PROMPTS: Record<string, string> = {
  "planner.md": `# Spec planner

Task: {{TOPIC}}

Decide which of these spec sections are actually needed to fully describe this task before
implementation starts. Skip a section if it clearly doesn't apply (e.g. a pure internal
refactor may not need "interfaces").

Known sections: requirements, interfaces, constraints, acceptance, edge_cases

Rules:
- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:
\`\`\`json
{"sections": ["requirements", "acceptance"]}
\`\`\`
`,
  "requirements.md": `# Requirements

Task: {{TOPIC}}

List the concrete functional and non-functional requirements this task must satisfy. Each
requirement should be a single, testable statement.

Rules:
${ID_RULES("R")}
- Leave "refs" empty ([]) - requirements are the foundation other sections point back to.
${TAIL("requirements", '{"id": "R1", "text": "...", "refs": []}')}
`,
  "interfaces.md": `# Interfaces

Task: {{TOPIC}}

Define the concrete interfaces/contracts this task introduces or changes: function
signatures, API endpoints, CLI commands, event shapes, config schemas - whatever is
externally observable.

Rules:
${ID_RULES("I")}
- Leave "refs" empty ([]) unless an interface exists specifically to satisfy one or more requirement ids - if so, list them.
${TAIL("interfaces", '{"id": "I1", "text": "...", "refs": []}')}
`,
  "constraints.md": `# Constraints

Task: {{TOPIC}}

List the constraints this task must respect: performance, security, backward compatibility,
platform limits, dependency/version limits - anything that limits how it can be built.

Rules:
${ID_RULES("C")}
- Leave "refs" empty ([]) unless a constraint exists specifically because of a requirement - if so, list its id(s).
${TAIL("constraints", '{"id": "C1", "text": "...", "refs": []}')}
`,
  "acceptance.md": `# Acceptance criteria

Task: {{TOPIC}}

Write acceptance criteria: concrete, checkable conditions that must hold for this task to
be considered done.

Rules:
${ID_RULES("A")}
- Every item MUST list "refs": the id(s) of the requirement(s) (or interface(s)) it verifies. An acceptance criterion with no ref is a criterion for nothing.
${TAIL("acceptance", '{"id": "A1", "text": "...", "refs": ["R1"]}')}
`,
  "edge-cases.md": `# Edge cases and risks

Task: {{TOPIC}}

List edge cases, failure modes, and risks this task needs to handle deliberately (not
accidentally).

Rules:
${ID_RULES("E")}
- Every item MUST list "refs": the id(s) of the requirement(s), interface(s), or constraint(s) it threatens or qualifies.
${TAIL("edge_cases", '{"id": "E1", "text": "...", "refs": ["R1"]}')}
`,
  "reviewer.md": `# Spec reviewer synthesis

Task: {{TOPIC}}

You are merging independent spec sections into ONE coherent context artifact that a future
implementation agent will read instead of the raw task description. Each section below was
written by a different model with no visibility into the others.

Your job:
- Merge every section into one JSON spec, keeping every item's original id.
- Resolve contradictions explicitly (state which item wins and why) inside "markdown".
- Do not drop any item silently - if something is wrong or redundant, say so in "markdown" but still carry the item through in "spec" (a gate checks that nothing vanishes without a trace).
- Do not invent ids that don't exist in the source sections.
- Write "markdown" as a standalone human-readable spec document, not a restatement of each section in turn.

Rules:
- Output ONLY ONE fenced json block, nothing before or after it, in this exact shape:
\`\`\`json
{
  "markdown": "...",
  "spec": {
    "requirements": [{"id": "R1", "text": "...", "refs": []}],
    "interfaces": [{"id": "I1", "text": "...", "refs": []}],
    "constraints": [{"id": "C1", "text": "...", "refs": []}],
    "acceptance": [{"id": "A1", "text": "...", "refs": ["R1"]}],
    "edge_cases": [{"id": "E1", "text": "...", "refs": ["R1"]}]
  }
}
\`\`\`
- Omit a section key entirely if no source section provided it.

Sections:
{{SECTION_REPORTS}}
`,
};

export function ensureSpecContextConfig(): void {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  } else {
    migrateConfigFile();
  }
  for (const [file, content] of Object.entries(DEFAULT_PROMPTS)) {
    const path = join(PROMPTS_DIR, file);
    if (!existsSync(path)) writeFileSync(path, content);
  }
}

/**
 * config.json is only written once, so fixes to DEFAULT_CONFIG never reach an
 * existing install on their own. This upgrades values that are still exactly
 * an old shipped default (never anything the user changed by hand):
 * - moves "kimi" off OpenRouter onto the kimi-coding subscription provider.
 */
function migrateConfigFile(): void {
  let cfg: SpecContextConfig;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as SpecContextConfig;
  } catch {
    return; // leave a broken file for loadSpecContextConfig to report clearly
  }
  const kimi = cfg.models?.kimi;
  if (kimi?.provider === "openrouter" && kimi?.model === "moonshotai/kimi-k2") {
    cfg.models.kimi = DEFAULT_CONFIG.models.kimi;
    writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
  }
}

export function loadSpecContextConfig(): SpecContextConfig {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as SpecContextConfig;
  validateSpecContextConfig(cfg);
  return cfg;
}

function validateSpecContextConfig(cfg: SpecContextConfig): void {
  const problems: string[] = [];
  const knownModels = Object.keys(cfg.models || {});
  for (const spec of [cfg.planner, ...(cfg.sections || []), cfg.reviewer]) {
    if (!spec) continue;
    if (!cfg.models?.[spec.modelKey]) {
      problems.push(`agent "${spec.role}": unknown modelKey "${spec.modelKey}" (known: ${knownModels.join(", ")})`);
    }
    if (!existsSync(join(PROMPTS_DIR, spec.promptFile))) {
      problems.push(`agent "${spec.role}": promptFile not found: ${spec.promptFile}`);
    }
  }
  if (problems.length) {
    throw new Error(`spec-context config invalid:\n- ${problems.join("\n- ")}`);
  }
}

export function resolveModel(cfg: SpecContextConfig, key: ModelKey): ModelRef {
  const ref = cfg.models[key];
  if (!ref) throw new Error(`spec-context config: unknown modelKey "${key}"`);
  return ref;
}
