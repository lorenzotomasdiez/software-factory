import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../../home";

export const WORKFLOW_DIR = join(ROOT_DIR, "workflows", "scout-context");
export const PROMPTS_DIR = join(WORKFLOW_DIR, "prompts");
export const RUNS_DIR = join(WORKFLOW_DIR, "runs");
export const CONFIG_FILE = join(WORKFLOW_DIR, "config.json");

export interface ModelRef {
  provider: string;
  model: string;
}

/** A name pointing at a provider+model pair in `models`, e.g. "deepseek" or "gemini-writer". */
export type ScoutAgentModelKey = string;

export interface ScoutSpec {
  role: string;
  modelKey: ScoutAgentModelKey;
  promptFile: string; // relative to PROMPTS_DIR
}

export interface ReviewerSpec {
  role: string;
  modelKey: ScoutAgentModelKey;
  promptFile: string;
}

export interface ScoutContextConfig {
  retries: number;
  models: Record<ScoutAgentModelKey, ModelRef>;
  scouts: ScoutSpec[];
  reviewer: ReviewerSpec;
}

const DEFAULT_CONFIG: ScoutContextConfig = {
  retries: 1,
  models: {
    "codex-gpt": { provider: "openai-codex", model: "gpt-5.6-luna" },
    // Cross-model by default: the reviewer never shares a model with any
    // scout below, so the synthesis step isn't graded by the same model
    // that wrote (some of) the material it's grading.
    "gemini-writer": { provider: "openrouter", model: "google/gemini-3.8-flash" },
  },
  scouts: [
    { role: "scout-structure", modelKey: "codex-gpt", promptFile: "scout-structure.md" },
    { role: "scout-dataflow", modelKey: "codex-gpt", promptFile: "scout-dataflow.md" },
    { role: "scout-conventions", modelKey: "codex-gpt", promptFile: "scout-conventions.md" },
  ],
  reviewer: { role: "reviewer", modelKey: "gemini-writer", promptFile: "reviewer.md" },
};

const SCOUT_JSON_CONTRACT = [
  "Rules:",
  "- You may only read/search the repo. Do not attempt to write, edit, or run mutating commands.",
  "- Be concrete: cite real file paths you actually found.",
  "- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:",
  '```json\n{"summary": "...", "findings": ["...", "..."], "files": ["path/one", "path/two"]}\n```',
].join("\n");

const DEFAULT_PROMPTS: Record<string, string> = {
  "scout-structure.md": `# Structure and entry points

Investigate: {{TOPIC}}

Map the project's structure: entry points, main modules/packages, how it's organized top to bottom.

${SCOUT_JSON_CONTRACT}
`,
  "scout-dataflow.md": `# Data flow and core logic

Investigate: {{TOPIC}}

Trace how data flows through the system and where the core business logic lives.

${SCOUT_JSON_CONTRACT}
`,
  "scout-conventions.md": `# Tests, config, and conventions

Investigate: {{TOPIC}}

Find how the project is tested and configured, and note recurring conventions/patterns.

${SCOUT_JSON_CONTRACT}
`,
  "reviewer.md": `# Reviewer synthesis

Topic: {{TOPIC}}

You are reviewing independent scout reports on the topic above, each written by a
different model with no visibility into the others. Your job is to cross-check
them, resolve any contradictions, and write ONE coherent Markdown report a human
can read standalone.

Rules:
- Do not just restate each scout's summary in turn - actually synthesize.
- If scouts disagree, say so explicitly and state which is better supported.
- Reference concrete files/findings from more than one scout where possible.
- Output ONLY the final Markdown report - no preamble, no meta-commentary.

Scout reports:
{{SCOUT_REPORTS}}
`,
};

export function ensureScoutContextConfig(): void {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
  for (const [file, content] of Object.entries(DEFAULT_PROMPTS)) {
    const path = join(PROMPTS_DIR, file);
    if (!existsSync(path)) writeFileSync(path, content);
  }
}

export function loadScoutContextConfig(): ScoutContextConfig {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as ScoutContextConfig;
  validateScoutContextConfig(cfg);
  return cfg;
}

function validateScoutContextConfig(cfg: ScoutContextConfig): void {
  const problems: string[] = [];
  const knownModels = Object.keys(cfg.models || {});
  for (const spec of [...(cfg.scouts || []), cfg.reviewer]) {
    if (!spec) continue;
    if (!cfg.models?.[spec.modelKey]) {
      problems.push(`agent "${spec.role}": unknown modelKey "${spec.modelKey}" (known: ${knownModels.join(", ")})`);
    }
    if (!existsSync(join(PROMPTS_DIR, spec.promptFile))) {
      problems.push(`agent "${spec.role}": promptFile not found: ${spec.promptFile}`);
    }
  }
  if (problems.length) {
    throw new Error(`scout-context config invalid:\n- ${problems.join("\n- ")}`);
  }
}

export function resolveModel(cfg: ScoutContextConfig, key: ScoutAgentModelKey): ModelRef {
  const ref = cfg.models[key];
  if (!ref) throw new Error(`scout-context config: unknown modelKey "${key}"`);
  return ref;
}
