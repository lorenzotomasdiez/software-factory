import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piExtensionArgs, piIsolationArgs } from "../../agent-launch";
import { ensureDashboardRunning } from "../../dashboard";
import { readBaseAgentPrompt } from "../../home";
import { emitWorkflowEvent } from "../events";
import type { ScoutResult, WorkflowResult } from "../types";
import {
  ensureScoutContextConfig,
  loadScoutContextConfig,
  PROMPTS_DIR,
  resolveModel,
  RUNS_DIR,
  type ReviewerSpec,
  type ScoutContextConfig,
  type ScoutSpec,
} from "./config";
import { extractJson, isScoutEnvelope, reviewerGates, scoutGates } from "./gates";
import { promptTitle, renderTemplate } from "./prompts";

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
      SF_PROFILE: "scout-context",
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

async function runScout(
  cfg: ScoutContextConfig,
  basePrompt: string,
  spec: ScoutSpec,
  topic: string,
  workflowId: string,
  cwd: string,
  dashboardUrl: string,
): Promise<ScoutResult> {
  const template = readFileSync(join(PROMPTS_DIR, spec.promptFile), "utf-8");
  const title = promptTitle(template);
  const instructionBody = renderTemplate(template, { TOPIC: topic });
  const systemPrompt = [
    basePrompt,
    "You are a read-only scout agent inside software-factory's `scout-context` workflow.",
    instructionBody,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { provider, model } = resolveModel(cfg, spec.modelKey);
  const sessionId = `sf-scout-${workflowId}-${spec.role}`;

  emitWorkflowEvent(workflowId, spec.role, "scout_start", { angle: title, provider, model });

  let lastError = "";
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const prompt =
      attempt === 1
        ? `Investigate: ${topic}`
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
      const checks = scoutGates(parsed, cwd);
      const failed = checks.filter((c) => !c.ok);
      emitWorkflowEvent(workflowId, spec.role, "gate_result", { attempt, checks });
      if (failed.length === 0 && isScoutEnvelope(parsed)) {
        emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: true, attempt });
        return { role: spec.role, angle: title, ok: true, attempts: attempt, envelope: parsed };
      }
      lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
  }

  emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: false, error: lastError });
  return { role: spec.role, angle: title, ok: false, attempts: cfg.retries + 1, error: lastError };
}

function fallbackConcat(topic: string, scouts: ScoutResult[]): string {
  const lines = [`# Scout report: ${topic}`, "", "_Reviewer synthesis failed - falling back to raw concatenation._", ""];
  for (const scout of scouts) {
    lines.push(`## ${scout.angle}`);
    if (scout.ok && scout.envelope) {
      lines.push(scout.envelope.summary, "");
      if (scout.envelope.findings.length) lines.push("Findings:", ...scout.envelope.findings.map((f) => `- ${f}`), "");
      if (scout.envelope.files.length) lines.push("Files:", ...scout.envelope.files.map((f) => `- \`${f}\``), "");
    } else {
      lines.push(`_Scout failed after ${scout.attempts} attempt(s): ${scout.error}_`, "");
    }
  }
  return lines.join("\n");
}

async function runReviewer(
  cfg: ScoutContextConfig,
  spec: ReviewerSpec,
  basePrompt: string,
  topic: string,
  scouts: ScoutResult[],
  workflowId: string,
  cwd: string,
  dashboardUrl: string,
): Promise<{ report: string; ok: boolean; error?: string }> {
  const template = readFileSync(join(PROMPTS_DIR, spec.promptFile), "utf-8");
  const scoutReportsText = scouts
    .map((s) => `### ${s.angle} (${s.role})\n${s.ok ? JSON.stringify(s.envelope, null, 2) : `FAILED: ${s.error}`}`)
    .join("\n\n");
  const instructionBody = renderTemplate(template, { TOPIC: topic, SCOUT_REPORTS: scoutReportsText });
  const systemPrompt = [basePrompt, instructionBody].filter(Boolean).join("\n\n");
  const { provider, model } = resolveModel(cfg, spec.modelKey);
  const sessionId = `sf-review-${workflowId}`;
  const scoutTexts = scouts.filter((s) => s.ok && s.envelope).map((s) => JSON.stringify(s.envelope));
  const scoutsForGate = scouts.filter((s) => s.ok && s.envelope).map((s) => ({ angle: s.angle, files: s.envelope!.files }));

  // Reuses the scout event-type names (scout_start/scout_retry/scout_end) so
  // the dashboard's existing per-role lane grouping picks the reviewer up as
  // just one more lane, with no dashboard changes needed.
  emitWorkflowEvent(workflowId, spec.role, "scout_start", { angle: promptTitle(template), provider, model });

  let lastError = "";
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const prompt = attempt === 1 ? "Write the synthesis report now." : `Your previous report failed validation:\n- ${lastError}\n\nRevise it.`;

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

    const report = result.stdout.trim();
    const checks = reviewerGates(report, scoutTexts, scoutsForGate);
    const failed = checks.filter((c) => !c.ok);
    emitWorkflowEvent(workflowId, spec.role, "gate_result", { attempt, checks });
    if (failed.length === 0) {
      emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: true, attempt });
      return { report, ok: true };
    }
    lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
    emitWorkflowEvent(workflowId, spec.role, "scout_retry", { attempt, error: lastError });
  }

  emitWorkflowEvent(workflowId, spec.role, "scout_end", { ok: false, error: lastError });
  return { report: fallbackConcat(topic, scouts), ok: false, error: lastError };
}

/**
 * Deterministic multi-agent recon with cross-model evaluation: each scout
 * angle/model/prompt is configured in ~/.software-factory/workflows/scout-context/
 * (config.json + prompts/*.md), so swapping a scout's model or rewriting its
 * prompt needs no code change. A reviewer agent - on a model that never
 * overlaps with any scout's - synthesizes the final report; both scouts and
 * the reviewer are gated by mechanical checks (JSON shape, files exist,
 * word-overlap against source material), never by another model's judgment.
 */
export async function runScoutContext(topic: string, cwd = process.cwd()): Promise<WorkflowResult> {
  ensureScoutContextConfig();
  const cfg = loadScoutContextConfig();
  const workflowId = randomUUID();
  const basePrompt = readBaseAgentPrompt();
  const dashboardUrl = await ensureDashboardRunning();

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_start", { topic, agents: cfg.scouts.length + 1 });

  const scouts = await Promise.all(
    cfg.scouts.map((spec) => runScout(cfg, basePrompt, spec, topic, workflowId, cwd, dashboardUrl)),
  );

  const review = await runReviewer(cfg, cfg.reviewer, basePrompt, topic, scouts, workflowId, cwd, dashboardUrl);

  const ok = scouts.every((s) => s.ok) && review.ok;
  const runDir = join(RUNS_DIR, workflowId);
  mkdirSync(runDir, { recursive: true });
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, review.report);

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_end", { ok, reportPath, reviewOk: review.ok });

  return { workflowId, ok, topic, scouts, report: review.report, reportPath };
}
