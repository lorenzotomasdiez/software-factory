import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piExtensionArgs, piIsolationArgs } from "../../agent-launch";
import { ensureDashboardRunning } from "../../dashboard";
import { readBaseAgentPrompt } from "../../home";
import { emitWorkflowEvent } from "../events";
import type { SpecContextWorkflowResult, SpecSectionResult } from "../types";
import {
  ensureSpecContextConfig,
  loadSpecContextConfig,
  PROMPTS_DIR,
  resolveModel,
  RUNS_DIR,
  type AgentSpec,
  type SectionAgentSpec,
  type SpecContextConfig,
} from "./config";
import {
  extractJson,
  isPlannerEnvelope,
  plannerGates,
  reviewerGates,
  sectionGates,
  type PlannerEnvelope,
  type ReviewerOutput,
  type SectionEnvelope,
} from "./gates";
import { promptTitle, renderTemplate } from "../scout-context/prompts";

const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnPi(opts: {
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  cwd: string;
  workflowId: string;
  role: string;
  dashboardUrl: string;
  tools?: string; // omit for no-tools (pure writing agents like the reviewer)
}): Promise<SpawnResult> {
  const toolArgs = opts.tools ? ["--tools", opts.tools] : ["--no-tools"];
  const proc = Bun.spawn({
    cmd: [
      "pi",
      "--print",
      "--provider",
      opts.provider,
      "--model",
      opts.model,
      "--append-system-prompt",
      opts.systemPrompt,
      ...piIsolationArgs(),
      ...piExtensionArgs(),
      ...toolArgs,
      "--session-id",
      opts.sessionId,
      opts.prompt,
    ],
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SF_WORKFLOW_ID: opts.workflowId,
      SF_ROLE: opts.role,
      SF_PROFILE: "spec-context",
      SF_DASHBOARD_URL: opts.dashboardUrl,
    },
  });

  const timeout = setTimeout(() => proc.kill(), AGENT_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return { stdout, stderr, exitCode };
}

async function runPlanner(
  cfg: SpecContextConfig,
  basePrompt: string,
  topic: string,
  workflowId: string,
  cwd: string,
  dashboardUrl: string,
): Promise<{ sections: SectionAgentSpec[]; ok: boolean; error?: string }> {
  const spec = cfg.planner;
  const template = readFileSync(join(PROMPTS_DIR, spec.promptFile), "utf-8");
  const instructionBody = renderTemplate(template, { TOPIC: topic });
  const systemPrompt = [
    basePrompt,
    "You are the planning agent inside software-factory's `spec-context` workflow.",
    instructionBody,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { provider, model } = resolveModel(cfg, spec.modelKey);
  const sessionId = `sf-spec-planner-${workflowId}`;

  emitWorkflowEvent(workflowId, spec.role, "scout_start", { angle: promptTitle(template), provider, model });

  let lastError = "";
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const prompt =
      attempt === 1
        ? `Plan the spec sections for: ${topic}`
        : `Your previous response failed validation:\n- ${lastError}\n\nFix it and re-emit ONLY the fenced json block.`;

    const result = await spawnPi({
      provider,
      model,
      systemPrompt,
      prompt,
      sessionId,
      cwd,
      workflowId,
      role: spec.role,
      dashboardUrl,
      tools: "read,grep,find,ls",
    });

    if (result.exitCode !== 0) {
      lastError = result.stderr.trim().slice(-500) || `exited ${result.exitCode}`;
      emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
      continue;
    }

    try {
      const parsed = extractJson(result.stdout);
      const checks = plannerGates(parsed);
      const failed = checks.filter((c) => !c.ok);
      emitWorkflowEvent(workflowId, spec.role, "gate_result", { attempt, checks });
      if (failed.length === 0 && isPlannerEnvelope(parsed)) {
        const chosen = cfg.sections.filter((s) => (parsed as PlannerEnvelope).sections.includes(s.section));
        emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: true, attempt, sections: chosen.map((s) => s.section) });
        return { sections: chosen.length ? chosen : cfg.sections, ok: true };
      }
      lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
  }

  // Planner never produced a valid section list - fail open and run every
  // configured section rather than produce zero context.
  emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: false, error: lastError, fallback: "all sections" });
  return { sections: cfg.sections, ok: false, error: lastError };
}

async function runSectionAgent(
  cfg: SpecContextConfig,
  basePrompt: string,
  spec: SectionAgentSpec,
  topic: string,
  workflowId: string,
  cwd: string,
  dashboardUrl: string,
): Promise<SpecSectionResult> {
  const template = readFileSync(join(PROMPTS_DIR, spec.promptFile), "utf-8");
  const title = promptTitle(template);
  const instructionBody = renderTemplate(template, { TOPIC: topic });
  const systemPrompt = [
    basePrompt,
    "You are a spec-writing agent inside software-factory's `spec-context` workflow.",
    instructionBody,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { provider, model } = resolveModel(cfg, spec.modelKey);
  const sessionId = `sf-spec-${workflowId}-${spec.role}`;

  emitWorkflowEvent(workflowId, spec.role, "scout_start", { angle: title, provider, model });

  let lastError = "";
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const prompt =
      attempt === 1
        ? `Write the "${spec.section}" section for: ${topic}`
        : `Your previous response failed validation:\n- ${lastError}\n\nFix it and re-emit ONLY the fenced json block.`;

    const result = await spawnPi({
      provider,
      model,
      systemPrompt,
      prompt,
      sessionId,
      cwd,
      workflowId,
      role: spec.role,
      dashboardUrl,
      tools: "read,grep,find,ls",
    });

    if (result.exitCode !== 0) {
      lastError = result.stderr.trim().slice(-500) || `exited ${result.exitCode}`;
      emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
      continue;
    }

    try {
      const parsed = extractJson(result.stdout);
      const checks = sectionGates(parsed, spec.section);
      const failed = checks.filter((c) => !c.ok);
      emitWorkflowEvent(workflowId, spec.role, "gate_result", { attempt, checks });
      if (failed.length === 0) {
        emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: true, attempt });
        return { role: spec.role, section: spec.section, angle: title, ok: true, attempts: attempt, envelope: parsed as SectionEnvelope };
      }
      lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
  }

  emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: false, error: lastError });
  return { role: spec.role, section: spec.section, angle: title, ok: false, attempts: cfg.retries + 1, error: lastError };
}

function fallbackSpec(topic: string, sections: SpecSectionResult[]): { markdown: string; specJson: string } {
  const lines = [`# Spec: ${topic}`, "", "_Reviewer synthesis failed - falling back to raw section concatenation._", ""];
  const spec: Record<string, unknown> = {};
  for (const s of sections) {
    lines.push(`## ${s.angle} (${s.section})`);
    if (s.ok && s.envelope) {
      for (const item of s.envelope.items) {
        lines.push(`- **${item.id}**: ${item.text}${item.refs?.length ? ` (refs: ${item.refs.join(", ")})` : ""}`);
      }
      spec[s.section] = s.envelope.items;
    } else {
      lines.push(`_Section failed after ${s.attempts} attempt(s): ${s.error}_`);
    }
    lines.push("");
  }
  return { markdown: lines.join("\n"), specJson: JSON.stringify(spec, null, 2) };
}

async function runReviewer(
  cfg: SpecContextConfig,
  basePrompt: string,
  topic: string,
  sections: SpecSectionResult[],
  workflowId: string,
  cwd: string,
  dashboardUrl: string,
): Promise<{ markdown: string; specJson: string; ok: boolean; error?: string }> {
  const spec: AgentSpec = cfg.reviewer;
  const template = readFileSync(join(PROMPTS_DIR, spec.promptFile), "utf-8");
  const okSections = sections.filter((s) => s.ok && s.envelope);
  const sectionReportsText = sections
    .map((s) => `### ${s.angle} (${s.section})\n${s.ok ? JSON.stringify(s.envelope, null, 2) : `FAILED: ${s.error}`}`)
    .join("\n\n");
  const instructionBody = renderTemplate(template, { TOPIC: topic, SECTION_REPORTS: sectionReportsText });
  const systemPrompt = [basePrompt, instructionBody].filter(Boolean).join("\n\n");
  const { provider, model } = resolveModel(cfg, spec.modelKey);
  const sessionId = `sf-spec-review-${workflowId}`;
  const sourceSections = okSections.map((s) => s.envelope!) as SectionEnvelope[];

  // Reuses the scout-context event-type names (scout_start/scout_retry/
  // scout_end) so the dashboard's existing per-role lane grouping picks this
  // workflow up too, with no dashboard changes needed.
  emitWorkflowEvent(workflowId, spec.role, "scout_start", { angle: promptTitle(template), provider, model });

  let lastError = "";
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const prompt = attempt === 1 ? "Merge the sections into the final spec now." : `Your previous output failed validation:\n- ${lastError}\n\nRevise it.`;

    const result = await spawnPi({
      provider,
      model,
      systemPrompt,
      prompt,
      sessionId,
      cwd,
      workflowId,
      role: spec.role,
      dashboardUrl,
    });

    if (result.exitCode !== 0) {
      lastError = result.stderr.trim().slice(-500) || `exited ${result.exitCode}`;
      emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
      continue;
    }

    try {
      const parsed = extractJson(result.stdout);
      const checks = reviewerGates(parsed, sourceSections);
      const failed = checks.filter((c) => !c.ok);
      emitWorkflowEvent(workflowId, spec.role, "gate_result", { attempt, checks });
      if (failed.length === 0) {
        const output = parsed as ReviewerOutput;
        emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: true, attempt });
        return { markdown: output.markdown, specJson: JSON.stringify(output.spec, null, 2), ok: true };
      }
      lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
  }

  emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: false, error: lastError });
  const fb = fallbackSpec(topic, sections);
  return { markdown: fb.markdown, specJson: fb.specJson, ok: false, error: lastError };
}

/**
 * Deterministic multi-agent spec generation, cross-LLM by design: a planner
 * picks which sections apply (requirements/interfaces/constraints/
 * acceptance/edge_cases), each section is written by a different model
 * (configured in ~/.software-factory/workflows/spec-context/, same
 * config.json + prompts/*.md pattern as scout-context), and a lead reviewer
 * - on a model that authored no section - merges everything into one spec,
 * gated by mechanical self-consistency checks (every id survives, every ref
 * resolves, every acceptance criterion traces to something) rather than by
 * another model's judgment.
 */
export async function runSpecContext(topic: string, cwd = process.cwd()): Promise<SpecContextWorkflowResult> {
  ensureSpecContextConfig();
  const cfg = loadSpecContextConfig();
  const workflowId = randomUUID();
  const basePrompt = readBaseAgentPrompt();
  const dashboardUrl = await ensureDashboardRunning();

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_start", {
    topic,
    agents: cfg.sections.length + 2,
    workflow: "spec-context",
  });

  const plan = await runPlanner(cfg, basePrompt, topic, workflowId, cwd, dashboardUrl);

  const sections = await Promise.all(
    plan.sections.map((spec) => runSectionAgent(cfg, basePrompt, spec, topic, workflowId, cwd, dashboardUrl)),
  );

  const review = await runReviewer(cfg, basePrompt, topic, sections, workflowId, cwd, dashboardUrl);

  // Same rule as scout-context: "ok" tracks whether the reviewer's own gated
  // merge succeeded, not whether every section individually succeeded - one
  // flaky section shouldn't veto a spec the reviewer already validated
  // around it. Zero surviving sections starves the reviewer and cascades to
  // review.ok=false on its own.
  const failedSections = sections.filter((s) => !s.ok);
  const ok = review.ok;
  const runDir = join(RUNS_DIR, workflowId);
  mkdirSync(runDir, { recursive: true });
  const specMdPath = join(runDir, "spec.md");
  const specJsonPath = join(runDir, "spec.json");
  writeFileSync(specMdPath, review.markdown);
  writeFileSync(specJsonPath, review.specJson);

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_end", {
    ok,
    specMdPath,
    specJsonPath,
    plannerOk: plan.ok,
    reviewOk: review.ok,
    failedSections: failedSections.map((s) => s.section),
  });

  return { workflowId, ok, topic, sections, markdown: review.markdown, specJson: review.specJson, specMdPath, specJsonPath };
}
