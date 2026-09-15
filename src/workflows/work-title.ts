import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractJson, type GateCheck } from "./scout-context/gates";

/**
 * A raw user request ("for doing phase 7 of plan.md") is an instruction, not a
 * name - it can't be a branch, a commit subject or a PR title, and there is
 * deliberately no fallback that turns it into one. The work is always named
 * by an agent that knows what it actually is: spec-context's planner (which
 * can read the plan the request points at), or - when that didn't happen -
 * the namer below, working from the finished spec's content.
 */
export const WORK_TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "chore"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const TITLE_MAX_CHARS = 72;

export interface WorkName {
  /** Short imperative name of the work, e.g. "Add OAuth login to the admin panel". */
  title: string;
  type: WorkType;
}

export interface WorkMeta extends WorkName {
  workflowId: string;
  /** The user's original request, verbatim. */
  topic: string;
}

export const META_FILE_NAME = "meta.json";

export function isWorkType(value: unknown): value is WorkType {
  return typeof value === "string" && (WORK_TYPES as readonly string[]).includes(value);
}

/** Slash-command args arrive with the user's literal quotes: `/spec-context "phase 4"` -> `"phase 4"`. */
export function stripWrappingQuotes(text: string): string {
  let out = text.trim();
  while (out.length >= 2 && /^["'`]/.test(out) && out.at(-1) === out[0]) out = out.slice(1, -1).trim();
  return out;
}

// Lives in code, not in any prompts/*.md: prompt files are only written on
// first install, and workNameGates enforces this contract on every install.
export const NAMING_RULES = `Naming the work (required - the json block MUST include "title" and "type"):
- The task text is often a pointer, not a description ("do phase 7 of plan.md", "the next item in TODO.md"). Never name the pointer - name what the work actually changes. If the pointed-at phase is "add a search command", the title is "Add note search command", not "Phase 7" or "Do phase 7 of plan.md".
- "title": one line, at most ${TITLE_MAX_CHARS} chars, English, imperative mood, sentence case, no trailing period - written like a good commit subject. It becomes the git branch, commit subject and PR title, so never mention the plan/phase/step/doc it came from.
- "type": exactly one of ${WORK_TYPES.join(", ")} - the kind of change, as in conventional commits.`;

// A title that names where the task is written down instead of what it does.
const POINTER_TITLE = /\.md\b|\b(phase|fase|step|paso|stage|etapa|milestone|hito)\s*#?\d+/i;

function titleProblem(title: unknown, topic: string): string | undefined {
  if (typeof title !== "string" || !title.trim()) return "missing title";
  const t = title.trim();
  if (t.length > TITLE_MAX_CHARS) return `title is ${t.length} chars (max ${TITLE_MAX_CHARS})`;
  if (t.includes("\n")) return "title must be a single line";
  if (POINTER_TITLE.test(t)) return `title "${t}" names where the task is written down (a doc/phase/step), not what the work does - name the actual change`;
  if (t.toLowerCase() === stripWrappingQuotes(topic).toLowerCase()) return "title just repeats the raw request - name the actual change";
  return undefined;
}

/** Deterministic checks on an agent-proposed work name. */
export function workNameGates(raw: unknown, topic: string): GateCheck[] {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const problem = titleProblem(v.title, topic);
  const typeOk = isWorkType(v.type);
  return [
    { name: "title", ok: !problem, detail: problem ?? `"${String(v.title).trim()}"` },
    { name: "work_type", ok: typeOk, detail: typeOk ? String(v.type) : `type must be one of: ${WORK_TYPES.join(", ")}` },
  ];
}

export interface NamerAgentRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Names work from a finished spec. The spec is the one artifact that always
 * describes the change itself (the request may only point at it), so this
 * needs no repo access. Each workflow supplies its own pi launcher.
 */
export async function nameWorkFromSpec(opts: {
  topic: string;
  specJson: string;
  specMarkdown?: string;
  retries: number;
  run: (systemPrompt: string, prompt: string, attempt: number) => Promise<NamerAgentRun>;
  onAttempt: (attempt: number, checks: GateCheck[] | undefined, error: string | undefined) => void;
}): Promise<{ ok: true; name: WorkName } | { ok: false; error: string }> {
  const systemPrompt = [
    "You name a unit of software work. You are given a finished spec for it and the original request that started it.",
    NAMING_RULES,
    `Output ONLY ONE fenced json block, nothing before or after it:\n\`\`\`json\n{"title": "Add note search command", "type": "feat"}\n\`\`\``,
    `Original request (may only be a pointer - do not name it):\n${opts.topic}`,
    opts.specMarkdown ? `Spec (prose):\n${opts.specMarkdown.slice(0, 12000)}` : "",
    `Spec (json):\n${opts.specJson.slice(0, 12000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let lastError = "";
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    const prompt = attempt === 1 ? "Name this work now." : `Your previous answer failed validation:\n- ${lastError}\n\nFix it and re-emit ONLY the fenced json block.`;
    const result = await opts.run(systemPrompt, prompt, attempt);
    if (result.exitCode !== 0) {
      lastError = result.stderr.trim().slice(-500) || `exited ${result.exitCode}`;
      opts.onAttempt(attempt, undefined, lastError);
      continue;
    }
    try {
      const parsed = extractJson(result.stdout) as Record<string, unknown>;
      const checks = workNameGates(parsed, opts.topic);
      const failed = checks.filter((c) => !c.ok);
      if (failed.length === 0) {
        opts.onAttempt(attempt, checks, undefined);
        return { ok: true, name: { title: String(parsed.title).trim(), type: parsed.type as WorkType } };
      }
      lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
      opts.onAttempt(attempt, checks, lastError);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      opts.onAttempt(attempt, undefined, lastError);
    }
  }
  return { ok: false, error: lastError };
}

/** Lowercase ascii kebab-case, accents folded, cut on a word boundary. Always a valid git ref segment. */
export function slugify(text: string, maxChars = 50): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxChars) return slug || "work";
  const cut = slug.slice(0, maxChars);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 10 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/** Conventional `<type>/<slug>` branch name, e.g. `feat/add-oauth-login-to-the-admin-panel`. */
export function branchNameFor(name: WorkName): string {
  return `${name.type}/${slugify(name.title)}`;
}

export function writeWorkMeta(runDir: string, meta: WorkMeta): string {
  const path = join(runDir, META_FILE_NAME);
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
  return path;
}

/** Reads the meta.json sitting next to a spec.json, if that spec's work was already named. */
export function readWorkMetaNextTo(specPath: string): WorkMeta | undefined {
  const path = join(dirname(specPath), META_FILE_NAME);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<WorkMeta>;
    if (typeof raw.title !== "string" || !raw.title.trim() || !isWorkType(raw.type)) return undefined;
    return { workflowId: raw.workflowId ?? "", topic: raw.topic ?? "", title: raw.title.trim(), type: raw.type };
  } catch {
    return undefined;
  }
}
