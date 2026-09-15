import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../../home";

export const WORKFLOW_DIR = join(ROOT_DIR, "workflows", "build-feature");
export const PROMPTS_DIR = join(WORKFLOW_DIR, "prompts");
export const RUNS_DIR = join(WORKFLOW_DIR, "runs");
export const WORKTREES_DIR = join(WORKFLOW_DIR, "worktrees");
export const CONFIG_FILE = join(WORKFLOW_DIR, "config.json");

export interface ModelRef {
  provider: string;
  model: string;
}

export type ModelKey = string;

export interface AgentSpec {
  role: string;
  modelKey: ModelKey;
  promptFile: string; // relative to PROMPTS_DIR
}

export interface BuildFeatureConfig {
  retries: number;
  baseBranch: string;
  buildCommand: string;
  testCommand: string;
  models: Record<ModelKey, ModelRef>;
  planner: AgentSpec;
  architect: AgentSpec;
  developer: AgentSpec;
  tester: AgentSpec;
  reviewer: AgentSpec;
}

const DEFAULT_CONFIG: BuildFeatureConfig = {
  retries: 2,
  baseBranch: "main",
  // "auto" = detected per target repo (see commands.ts). A repo can pin its
  // own via .sf/build-feature.json; a non-"auto" value here applies to all repos.
  buildCommand: "auto",
  testCommand: "auto",
  models: {
    // "terra" is the next tier up from "luna" in your gpt-5.6 lineup - swap
    // the model string below if that's not the exact id your pi setup uses.
    terra: { provider: "openai-codex", model: "gpt-5.6-terra" },
    luna: { provider: "openai-codex", model: "gpt-5.6-luna" },
    opus: { provider: "openrouter", model: "anthropic/claude-opus-5" },
    sonnet: { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    deepseek: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
    // Kimi subscription (OAuth-logged in pi), not pay-per-token OpenRouter.
    kimi: { provider: "kimi-coding", model: "k3" },
    gemini: { provider: "openrouter", model: "google/gemini-3.8-flash" },
  },
  planner: { role: "planner", modelKey: "terra", promptFile: "planner.md" },
  // "opus" (anthropic/claude-opus-5 via openrouter) fails every call with
  // "Mid-conversation reasoning effort (configuration_update) is not
  // supported" unless pi is told not to send that block: pi's built-in
  // catalog marks the model `compat.supportsMidConvoEffort: true`, which
  // OpenRouter rejects. The fix is a pi `modelOverrides` entry in
  // ~/.pi/agent/models.json setting it to false (plus a lower `maxTokens`,
  // since OpenRouter reserves credit for pi's 128k default). Architect/reviewer
  // default to "gemini" so a fresh install works without that override;
  // switch modelKey back to "opus" once it's in place.
  architect: { role: "architect", modelKey: "gemini", promptFile: "architect.md" },
  developer: { role: "developer", modelKey: "deepseek", promptFile: "developer.md" },
  tester: { role: "tester", modelKey: "kimi", promptFile: "tester.md" },
  reviewer: { role: "reviewer", modelKey: "gemini", promptFile: "reviewer.md" },
};

const DEFAULT_PROMPTS: Record<string, string> = {
  "planner.md": `# Feature planner

You are planning the implementation of a feature inside an existing codebase, based on a
structured spec (requirements, interfaces, constraints, acceptance criteria, edge cases).

Spec:
{{SPEC_JSON}}

Break the spec into an ordered list of concrete implementation steps. Each step should be
small enough to implement and verify independently, in the order they should be done.

Rules:
- Give each step a short stable id, e.g. "S1", "S2".
- Each step MUST list "refs": the id(s) of the spec item(s) it addresses.
- Every requirement (R*) and acceptance criterion (A*) in the spec must be referenced by at
  least one step - nothing gets silently skipped.
- List the file(s) you expect each step to touch in "files" (best guess, can include new files).
- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:
\`\`\`json
{"steps": [{"id": "S1", "description": "...", "refs": ["R1"], "files": ["src/foo.ts"]}]}
\`\`\`
`,
  "architect.md": `# Architect

You are designing the concrete technical approach for a feature, given the plan and spec
below. You have read-only access to the actual repository - use it to ground your design in
what's really there (existing modules, conventions, patterns), not assumptions.

Spec:
{{SPEC_JSON}}

Plan:
{{PLAN_JSON}}

For each plan step, define the concrete technical design: function/module signatures, where
it hooks into existing code, data structures, and anything a developer needs to implement it
without re-deriving the approach themselves.

Rules:
- Cover EVERY step id from the plan - no step left without a design entry.
- Reference real file paths that exist in the repo, or clearly mark new files as new.
- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:
\`\`\`json
{"design": [{"stepId": "S1", "approach": "...", "files": ["src/foo.ts"]}]}
\`\`\`
`,
  "developer.md": `# Developer

Implement the feature below in this repository. You are on a dedicated branch in an isolated
worktree - real changes are expected. The harness commits after you finish; you don't need to
commit, push, or create branches yourself.

Spec:
{{SPEC_JSON}}

Plan:
{{PLAN_JSON}}

Architecture:
{{ARCHITECTURE_JSON}}

Rules:
- Implement every step in the plan, following the architect's design.
- Before you finish, run \`{{BUILD_COMMAND}}\` yourself and fix any errors it reports - do not
  hand off a build that doesn't compile.
- Do not run destructive git commands. Do not push or create branches - the harness handles that.
- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:
\`\`\`json
{"filesChanged": ["src/foo.ts"], "summary": "..."}
\`\`\`
`,
  "tester.md": `# Tester

Verify the implementation below against the spec's acceptance criteria and edge cases. You
have full tool access (read/write/edit/bash) in this same worktree.

Spec:
{{SPEC_JSON}}

Developer's summary of changes:
{{DEV_SUMMARY}}

Rules:
- Run \`{{TEST_COMMAND}}\` and read the actual output - do not assume it passes.
- Add or fix tests as needed to cover the acceptance criteria (A*) and edge cases (E*) from
  the spec, then re-run \`{{TEST_COMMAND}}\` until it genuinely passes.
- Do not weaken or delete a test just to make it pass. If you believe the underlying code is
  wrong, say so plainly in your summary rather than papering over it.
- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:
\`\`\`json
{"testsAdded": ["path/to/test.ts"], "summary": "..."}
\`\`\`
`,
  "reviewer.md": `# Final reviewer

You are auditing a completed implementation against its original spec. You did not write any
of the code below - your job is to verify, not to have opinions about style.

Spec:
{{SPEC_JSON}}

Plan:
{{PLAN_JSON}}

Architecture:
{{ARCHITECTURE_JSON}}

Developer summary:
{{DEV_SUMMARY}}

Tester summary:
{{TEST_SUMMARY}}

Actual diff against {{BASE_BRANCH}}:
{{DIFF}}

Build passed: {{BUILD_OK}}
Tests passed: {{TEST_OK}}

For EVERY item id in the spec (every R*, I*, C*, A*, E*), determine its status from the actual
diff above, not from anyone's claims: "done", "partial", or "missing".

Rules:
- Cover every single spec item id - none may be omitted.
- "readyForReview" must be false if Build passed or Tests passed above is false.
- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:
\`\`\`json
{"summary": "...", "coverage": [{"id": "R1", "status": "done", "note": "..."}], "readyForReview": true}
\`\`\`
`,
};

export function ensureBuildFeatureConfig(): void {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(WORKTREES_DIR, { recursive: true });
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
 * - adds model keys introduced later (e.g. "gemini"),
 * - moves architect/reviewer off the original "opus" default, which fails
 *   every call via OpenRouter (see DEFAULT_CONFIG),
 * - moves "kimi" off OpenRouter onto the kimi-coding subscription provider,
 * - moves "deepseek" from v3.2 to v4.1-flash,
 * - replaces the original bun-only build/test commands with "auto".
 */
function migrateConfigFile(): void {
  let cfg: BuildFeatureConfig;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as BuildFeatureConfig;
  } catch {
    return; // leave a broken file for loadBuildFeatureConfig to report clearly
  }
  let changed = false;

  cfg.models ??= {};
  for (const [key, ref] of Object.entries(DEFAULT_CONFIG.models)) {
    if (!cfg.models[key]) {
      cfg.models[key] = ref;
      changed = true;
    }
  }

  const originalOpus = cfg.models.opus;
  const opusIsOriginal = originalOpus?.provider === "openrouter" && originalOpus?.model === "anthropic/claude-opus-5";
  for (const role of ["architect", "reviewer"] as const) {
    if (cfg[role]?.modelKey === "opus" && opusIsOriginal) {
      cfg[role].modelKey = DEFAULT_CONFIG[role].modelKey;
      changed = true;
    }
  }

  const kimi = cfg.models.kimi;
  if (kimi?.provider === "openrouter" && kimi?.model === "moonshotai/kimi-k3") {
    cfg.models.kimi = DEFAULT_CONFIG.models.kimi;
    changed = true;
  }

  const deepseek = cfg.models.deepseek;
  if (deepseek?.provider === "openrouter" && deepseek?.model === "deepseek/deepseek-v3.2") {
    cfg.models.deepseek = DEFAULT_CONFIG.models.deepseek;
    changed = true;
  }

  if (cfg.buildCommand === "bunx tsc --noEmit") {
    cfg.buildCommand = "auto";
    changed = true;
  }
  if (cfg.testCommand === "bun test") {
    cfg.testCommand = "auto";
    changed = true;
  }

  if (changed) writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function loadBuildFeatureConfig(): BuildFeatureConfig {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as BuildFeatureConfig;
  validateBuildFeatureConfig(cfg);
  return cfg;
}

function validateBuildFeatureConfig(cfg: BuildFeatureConfig): void {
  const problems: string[] = [];
  const knownModels = Object.keys(cfg.models || {});
  for (const spec of [cfg.planner, cfg.architect, cfg.developer, cfg.tester, cfg.reviewer]) {
    if (!spec) continue;
    if (!cfg.models?.[spec.modelKey]) {
      problems.push(`agent "${spec.role}": unknown modelKey "${spec.modelKey}" (known: ${knownModels.join(", ")})`);
    }
    if (!existsSync(join(PROMPTS_DIR, spec.promptFile))) {
      problems.push(`agent "${spec.role}": promptFile not found: ${spec.promptFile}`);
    }
  }
  if (!cfg.buildCommand?.trim()) problems.push("buildCommand must not be empty");
  if (!cfg.testCommand?.trim()) problems.push("testCommand must not be empty");
  if (!cfg.baseBranch?.trim()) problems.push("baseBranch must not be empty");
  if (problems.length) {
    throw new Error(`build-feature config invalid:\n- ${problems.join("\n- ")}`);
  }
}

export function resolveModel(cfg: BuildFeatureConfig, key: ModelKey): ModelRef {
  const ref = cfg.models[key];
  if (!ref) throw new Error(`build-feature config: unknown modelKey "${key}"`);
  return ref;
}
