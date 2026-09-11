import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_EXTENSION_FILE, ROOT_DIR } from "../home";
import { piExtensionArgs, piIsolationArgs } from "../agent-launch";
import { readBaseAgentPrompt } from "../home";
import { ensureDashboardRunning } from "../dashboard";
import { emitWorkflowEvent } from "./events";
import type { ScoutEnvelope, ScoutResult, WorkflowResult } from "./types";

export const WORKFLOWS_DIR = join(ROOT_DIR, "workflows");

const JSON_FIX_ATTEMPTS = 1; // bounded correction retries, same session resumed via --session-id
const SCOUT_TIMEOUT_MS = 5 * 60 * 1000;

const SCOUT_ANGLES = [
  {
    role: "scout-structure",
    angle: "structure and entry points",
    instruction:
      "Map the project's structure: entry points, main modules/packages, how it's organized top to bottom.",
  },
  {
    role: "scout-dataflow",
    angle: "data flow and core logic",
    instruction: "Trace how data flows through the system and where the core business logic lives.",
  },
  {
    role: "scout-conventions",
    angle: "tests, config, and conventions",
    instruction: "Find how the project is tested and configured, and note recurring conventions/patterns.",
  },
] as const;

function scoutSystemPrompt(basePrompt: string, topic: string, instruction: string): string {
  const parts = [basePrompt].filter(Boolean);
  parts.push(
    [
      "You are a read-only scout agent inside software-factory's `scout-context` workflow.",
      `Topic: ${topic}`,
      `Your specific angle: ${instruction}`,
      "Rules:",
      "- You may only read/search the repo. Do not attempt to write, edit, or run mutating commands.",
      "- Be concrete: cite real file paths you actually found.",
      "- End your final message with EXACTLY ONE fenced json block, nothing after it, in this shape:",
      '```json\n{"summary": "...", "findings": ["...", "..."], "files": ["path/one", "path/two"]}\n```',
    ].join("\n"),
  );
  return parts.join("\n\n");
}

function extractJson(text: string): unknown {
  let candidate = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) candidate = fenceMatch[1];
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in scout output");
  return JSON.parse(candidate.slice(start, end + 1));
}

function isScoutEnvelope(value: unknown): value is ScoutEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" && Array.isArray(v.findings) && Array.isArray(v.files)
  );
}

async function runScout(
  workflowId: string,
  topic: string,
  angle: (typeof SCOUT_ANGLES)[number],
  basePrompt: string,
  cwd: string,
  dashboardUrl: string,
): Promise<ScoutResult> {
  const sessionId = `sf-scout-${workflowId}-${angle.role}`;
  const systemPrompt = scoutSystemPrompt(basePrompt, topic, angle.instruction);
  emitWorkflowEvent(workflowId, angle.role, "scout_start", { angle: angle.angle });

  let lastText = "";
  let lastError = "";

  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt++) {
    const prompt =
      attempt === 1
        ? `Investigate: ${topic}`
        : `Your previous response was not valid JSON per the required shape (${lastError}). ` +
          "Re-emit ONLY the fenced json block described in your instructions, nothing else.";

    const proc = Bun.spawn({
      cmd: [
        "pi",
        "--print",
        "--append-system-prompt",
        systemPrompt,
        ...piIsolationArgs(),
        ...piExtensionArgs(),
        "--tools",
        "read,grep,find,ls",
        "--session-id",
        sessionId,
        prompt,
      ],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SF_WORKFLOW_ID: workflowId,
        SF_ROLE: angle.role,
        SF_PROFILE: "scout-context",
        SF_DASHBOARD_URL: dashboardUrl,
      },
    });

    const timeout = setTimeout(() => proc.kill(), SCOUT_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);
    lastText = stdout;

    if (exitCode !== 0) {
      lastError = stderr.trim().slice(-500) || `exited ${exitCode}`;
      emitWorkflowEvent(workflowId, angle.role, "scout_retry", { attempt, error: lastError });
      continue;
    }

    try {
      const parsed = extractJson(stdout);
      if (!isScoutEnvelope(parsed)) throw new Error("missing summary/findings/files fields");
      emitWorkflowEvent(workflowId, angle.role, "scout_end", { ok: true, attempt });
      return { role: angle.role, angle: angle.angle, ok: true, attempts: attempt, envelope: parsed };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      emitWorkflowEvent(workflowId, angle.role, "scout_retry", { attempt, error: lastError });
    }
  }

  emitWorkflowEvent(workflowId, angle.role, "scout_end", { ok: false, error: lastError });
  return {
    role: angle.role,
    angle: angle.angle,
    ok: false,
    attempts: JSON_FIX_ATTEMPTS + 1,
    error: lastError || "scout produced no parseable output",
  };
}

function synthesizeReport(topic: string, scouts: ScoutResult[]): string {
  const lines = [`# Scout report: ${topic}`, ""];
  for (const scout of scouts) {
    lines.push(`## ${scout.angle}`);
    if (scout.ok && scout.envelope) {
      lines.push(scout.envelope.summary, "");
      if (scout.envelope.findings.length) {
        lines.push("Findings:");
        for (const f of scout.envelope.findings) lines.push(`- ${f}`);
        lines.push("");
      }
      if (scout.envelope.files.length) {
        lines.push("Files:");
        for (const f of scout.envelope.files) lines.push(`- \`${f}\``);
        lines.push("");
      }
    } else {
      lines.push(`_Scout failed after ${scout.attempts} attempt(s): ${scout.error}_`, "");
    }
  }
  return lines.join("\n");
}

/**
 * Deterministic multi-agent recon: spawns one read-only scout per angle in
 * parallel, checks each for a well-formed envelope (bounded retry via the
 * same resumed session on failure), then merges results with no further LLM
 * call. Mirrors sssf's ADW phase/gate/retry model, adapted to Pi's print mode.
 */
export async function runScoutContext(topic: string, cwd = process.cwd()): Promise<WorkflowResult> {
  const workflowId = randomUUID();
  const basePrompt = readBaseAgentPrompt();
  const dashboardUrl = await ensureDashboardRunning();

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_start", { topic, agents: SCOUT_ANGLES.length });

  const scouts = await Promise.all(
    SCOUT_ANGLES.map((angle) => runScout(workflowId, topic, angle, basePrompt, cwd, dashboardUrl)),
  );

  const ok = scouts.every((s) => s.ok);
  const report = synthesizeReport(topic, scouts);

  const sessionDir = join(WORKFLOWS_DIR, workflowId);
  mkdirSync(sessionDir, { recursive: true });
  const reportPath = join(sessionDir, "report.md");
  writeFileSync(reportPath, report);

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_end", { ok, reportPath });

  return { workflowId, ok, topic, scouts, report, reportPath };
}
