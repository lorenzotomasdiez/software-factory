import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT_DIR = join(homedir(), ".software-factory");
export const AGENT_FILE = join(ROOT_DIR, "AGENT.md");
export const CONFIG_FILE = join(ROOT_DIR, "config.json");
export const PROFILES_DIR = join(ROOT_DIR, "profiles");
export const EXTENSIONS_DIR = join(ROOT_DIR, "extensions");
export const DEFAULT_EXTENSION_FILE = join(EXTENSIONS_DIR, "default.ts");
export const HOOKS_DIR = join(ROOT_DIR, "hooks");
export const EVENTS_DIR = join(ROOT_DIR, "events");

const DEFAULT_AGENT_MD = `# AGENT.md

This is software-factory's base system prompt: it is appended to every
\`sf\` launch of claude or pi, regardless of which --profile is selected.

Write your always-on preferences and rules here.
`;

export interface AgentDefaults {
  provider?: string;
  model?: string;
}

export interface SfConfig {
  agents?: {
    claude?: AgentDefaults;
    pi?: AgentDefaults;
  };
}

const DEFAULT_EXTENSION = `// software-factory's default Pi extension.
// Loaded automatically on every \`sf pi\` launch (via -e), not on bare \`pi\`.
// Edit freely - this file is yours.
//
// Besides the status line, this streams session events (JSON lines) into
// ~/.software-factory/events/<session_id>.jsonl for \`sf dashboard\` to read.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EVENTS_DIR = join(homedir(), ".software-factory", "events");

function emit(sessionId: string, type: string, data?: unknown) {
  try {
    mkdirSync(EVENTS_DIR, { recursive: true });
    const workflowId = process.env.SF_WORKFLOW_ID;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sessionId,
      agent: "pi",
      profile: process.env.SF_PROFILE || "default",
      provider: process.env.SF_PROVIDER,
      model: process.env.SF_MODEL,
      workflow_id: workflowId,
      role: process.env.SF_ROLE,
      type,
      data,
    });
    // Scout children write into the parent workflow's own event file so the
    // dashboard groups them as one swim-laned trace instead of N loose sessions.
    const file = workflowId ? \`\${workflowId}.jsonl\` : \`\${sessionId}.jsonl\`;
    appendFileSync(join(EVENTS_DIR, file), line + "\\n");
  } catch {
    // observability must never break the session
  }
}

export default function (pi: ExtensionAPI) {
  let sessionId = "unknown";
  let sessionCostUsd = 0;

  pi.on("session_start", async (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId?.() ?? sessionId;
    const profile = process.env.SF_PROFILE || "default";
    const provider = process.env.SF_PROVIDER;
    const model = process.env.SF_MODEL;
    const dashboardUrl = process.env.SF_DASHBOARD_URL;
    const modelPart = provider && model ? \` · \${provider}/\${model}\` : "";
    const obsPart = dashboardUrl ? \` · obs: \${dashboardUrl}\` : "";
    ctx.ui.setStatus("software-factory", \`🏭 sf · \${profile}\${modelPart}\${obsPart}\`);
    emit(sessionId, "session_start", { reason: event.reason });
  });

  pi.on("tool_execution_start", async (event) => {
    emit(sessionId, "tool_call", { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
  });

  pi.on("tool_execution_end", async (event) => {
    emit(sessionId, "tool_result", { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
  });

  pi.on("turn_end", async (event, ctx) => {
    const usage = ctx.getContextUsage?.();
    // pi computes real dollar cost per turn from its own model pricing tables
    // (message.usage.cost.total) - same source sssf's agent_pi.py reads. Only
    // an assistant message carries usage; anything else (rare) is skipped.
    const message = event.message as { role?: string; usage?: { cost?: { total?: number } } } | undefined;
    const turnCostUsd = message?.role === "assistant" ? (message.usage?.cost?.total ?? 0) : 0;
    sessionCostUsd += turnCostUsd;
    emit(sessionId, "turn_end", {
      turnIndex: event.turnIndex,
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      contextPercent: usage?.percent ?? null,
      turnCostUsd,
      sessionCostUsd,
    });
  });

  pi.on("session_shutdown", async (event) => {
    emit(sessionId, "session_end", { reason: event.reason });
  });

  pi.registerCommand("scout-context", {
    description: "Launch a team of read-only scout agents to map the codebase around a topic",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /scout-context <topic>", "warning");
        return;
      }
      ctx.ui.notify(\`Scouting: \${args} (background team launched, see \${process.env.SF_DASHBOARD_URL || "sf dashboard"})\`, "info");
      const { report, err, exitCode } = await new Promise<{ report: string; err: string; exitCode: number }>(
        (resolve) => {
          const proc = spawn("sf", ["workflow", "scout-context", args], { cwd: ctx.cwd });
          let out = "";
          let errOut = "";
          proc.stdout.on("data", (chunk) => (out += chunk));
          proc.stderr.on("data", (chunk) => (errOut += chunk));
          proc.on("close", (code) => resolve({ report: out, err: errOut, exitCode: code ?? 1 }));
        },
      );
      // A nonzero exit means the workflow's own deterministic gates weren't
      // fully satisfied (e.g. the reviewer never passed) - it does NOT mean
      // nothing useful was produced. \`sf workflow scout-context\` always
      // writes report.md, even a fallback concatenation, so surface whatever
      // exists rather than throwing away real work because of an exit code.
      // Only a truly empty report - a crash before anything was written -
      // is treated as a hard failure with no data.
      if (!report.trim()) {
        ctx.ui.notify(\`scout-context failed: \${err.slice(0, 300) || "no report was produced"}\`, "error");
        return;
      }
      if (exitCode !== 0) {
        ctx.ui.notify(\`scout-context finished with a warning - see \${process.env.SF_DASHBOARD_URL || "sf dashboard"} for which gate failed. Delivering the report anyway.\`, "warning");
      }
      pi.sendUserMessage(
        \`Here is the scout-context report on "\${args}"\${exitCode !== 0 ? " (one or more deterministic gates did not fully pass - treat it as a best-effort draft and double-check anything surprising)" : ""}. Use it to answer, don't re-scout unless it's missing something:\\n\\n\${report}\`,
        { deliverAs: "followUp" },
      );
    },
  });
}
`;

const DEFAULT_CONFIG: SfConfig = {
  agents: {
    claude: { model: "claude-opus-5" },
    pi: { provider: "openai-codex", model: "gpt-5.6-luna" },
  },
};

export function ensureHome(): void {
  mkdirSync(ROOT_DIR, { recursive: true });
  mkdirSync(PROFILES_DIR, { recursive: true });
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  mkdirSync(HOOKS_DIR, { recursive: true });
  mkdirSync(EVENTS_DIR, { recursive: true });

  if (!existsSync(AGENT_FILE)) {
    writeFileSync(AGENT_FILE, DEFAULT_AGENT_MD);
  }
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
  if (!existsSync(DEFAULT_EXTENSION_FILE)) {
    writeFileSync(DEFAULT_EXTENSION_FILE, DEFAULT_EXTENSION);
  }
}

export function readBaseAgentPrompt(): string {
  if (!existsSync(AGENT_FILE)) return "";
  return readFileSync(AGENT_FILE, "utf-8").trim();
}

export function readConfig(): SfConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as SfConfig;
  } catch (err) {
    console.error(`sf: failed to parse ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
