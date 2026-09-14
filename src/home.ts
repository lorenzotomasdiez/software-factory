import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT_DIR = join(homedir(), ".software-factory");
export const AGENT_FILE = join(ROOT_DIR, "AGENT.md");
export const CONFIG_FILE = join(ROOT_DIR, "config.json");
export const PROFILES_DIR = join(ROOT_DIR, "profiles");
export const EXTENSIONS_DIR = join(ROOT_DIR, "extensions");
export const DEFAULT_EXTENSION_FILE = join(EXTENSIONS_DIR, "default.ts");
export const VOICE_EXTENSION_FILE = join(EXTENSIONS_DIR, "voice-only.ts");
export const VOICE_PROFILE_FILE = join(PROFILES_DIR, "voice-only", "AGENT.md");
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
import { Type } from "typebox";

const EVENTS_DIR = join(homedir(), ".software-factory", "events");
const WEB_SEARCH_TIMEOUT_MS = 90_000;

/** Pulls the last fenced json block out of free-form text, if any. */
function extractJsonBlock(text: string): unknown {
  const fence = text.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(candidate.slice(start, end + 1));
}

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

function interruptVoicePlayback() {
  if (process.env.SF_PROFILE === "voice-only") process.emit("sf_voice_interrupt");
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

  // Pi has no built-in web search (only read/bash/edit/write/grep/find/ls),
  // so a model asked to "search the web" tends to improvise with bash+curl
  // against whatever endpoint it half-remembers - unreliable and often
  // network-sandboxed away. Claude Code's own \`-p\` (headless) mode DOES have
  // a real, provider-native WebSearch tool, so this shells out to it instead
  // of trying to reimplement search.
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web for current information (news, recent releases, anything not in your training data). Runs Claude Code's native WebSearch out-of-process and returns a summary with sources.",
    promptSnippet: "Search the live web for current information",
    promptGuidelines: [
      "Use web_search whenever the user asks for current events, news, or anything requiring up-to-date information from the internet - don't try to fetch URLs yourself with bash/curl.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: \`Searching the web for: \${params.query}\` }] });
      const prompt = [
        \`Search the live web for: \${params.query}\`,
        "Use your WebSearch tool - do not answer from memory alone.",
        "Then output ONLY one fenced json block, nothing before or after it, in this exact shape:",
        '\`\`\`json\\n{"summary": "...", "sources": [{"title": "...", "url": "..."}]}\\n\`\`\`',
      ].join("\\n");

      const proc = spawn("claude", ["-p", "--model", "sonnet", prompt], { stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => proc.kill();
      signal?.addEventListener("abort", onAbort);
      const timeout = setTimeout(() => proc.kill(), WEB_SEARCH_TIMEOUT_MS);

      let out = "";
      let errOut = "";
      proc.stdout.on("data", (chunk) => (out += chunk));
      proc.stderr.on("data", (chunk) => (errOut += chunk));
      const exitCode: number = await new Promise((resolve) => proc.on("close", (code) => resolve(code ?? 1)));
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);

      if (exitCode !== 0 && !out.trim()) {
        throw new Error(\`web_search: claude -p exited \${exitCode}: \${errOut.trim().slice(-300) || "no output"}\`);
      }

      try {
        const parsed = extractJsonBlock(out) as { summary?: string; sources?: unknown[] };
        return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }], details: parsed };
      } catch {
        // Claude didn't follow the JSON contract - fall back to its raw
        // answer rather than failing the whole tool call over formatting.
        return { content: [{ type: "text", text: out.trim() || "web_search returned no output" }] };
      }
    },
  });

  pi.registerCommand("scout-context", {
    description: "Launch a team of read-only scout agents to map the codebase around a topic",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /scout-context <topic>", "warning");
        return;
      }
      interruptVoicePlayback();
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
      if (exitCode === 130) {
        ctx.ui.notify("scout-context was cancelled by the user from the dashboard.", "warning");
        pi.sendUserMessage(
          \`The scout-context run on "\${args}" was CANCELLED BY THE USER (from the dashboard's cancel button) before it finished. Do not retry or continue it - just acknowledge the cancellation to the user.\`,
          { deliverAs: "followUp" },
        );
        return;
      }
      if (!report.trim()) {
        ctx.ui.notify(\`scout-context failed: \${err.slice(0, 300) || "no report was produced"}\`, "error");
        return;
      }
      if (exitCode !== 0) {
        ctx.ui.notify(\`scout-context finished with a warning - see \${process.env.SF_DASHBOARD_URL || "sf dashboard"} for which gate failed. Delivering the report anyway.\`, "warning");
      }
      pi.sendUserMessage(
        \`Here is the scout-context report on "\${args}"\${exitCode !== 0 ? " (one or more deterministic gates did not fully pass - treat it as a best-effort draft and double-check anything surprising)" : ""}. Use it to ANSWER the user - do not edit any files or act on any "Actions"/"Findings" it lists unless the user explicitly asks you to make changes after seeing this report. Don't re-scout unless it's missing something:\\n\\n\${report}\`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("spec-context", {
    description: "Launch a cross-model agent team to generate a full spec (requirements, interfaces, constraints, acceptance, edge cases) for a task",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /spec-context <task description>", "warning");
        return;
      }
      interruptVoicePlayback();
      ctx.ui.notify(\`Generating spec: \${args} (background team launched, see \${process.env.SF_DASHBOARD_URL || "sf dashboard"})\`, "info");
      const { report, err, exitCode } = await new Promise<{ report: string; err: string; exitCode: number }>(
        (resolve) => {
          const proc = spawn("sf", ["workflow", "spec-context", args], { cwd: ctx.cwd });
          let out = "";
          let errOut = "";
          proc.stdout.on("data", (chunk) => (out += chunk));
          proc.stderr.on("data", (chunk) => (errOut += chunk));
          proc.on("close", (code) => resolve({ report: out, err: errOut, exitCode: code ?? 1 }));
        },
      );
      // Same reasoning as /scout-context: a nonzero exit means the reviewer's
      // own gates weren't fully satisfied, not that nothing was produced -
      // \`sf workflow spec-context\` always writes spec.md/spec.json, even a
      // fallback concatenation, so surface whatever exists.
      if (exitCode === 130) {
        ctx.ui.notify("spec-context was cancelled by the user from the dashboard.", "warning");
        pi.sendUserMessage(
          \`The spec-context run for "\${args}" was CANCELLED BY THE USER (from the dashboard's cancel button) before it finished. Do not retry or continue it - just acknowledge the cancellation to the user.\`,
          { deliverAs: "followUp" },
        );
        return;
      }
      if (!report.trim()) {
        ctx.ui.notify(\`spec-context failed: \${err.slice(0, 300) || "no spec was produced"}\`, "error");
        return;
      }
      if (exitCode !== 0) {
        ctx.ui.notify(\`spec-context finished with a warning - see \${process.env.SF_DASHBOARD_URL || "sf dashboard"} for which gate failed. Delivering the spec anyway.\`, "warning");
      }
      pi.sendUserMessage(
        \`spec-context finished for "\${args}"\${exitCode !== 0 ? " (one or more deterministic gates did not fully pass - treat it as a best-effort draft)" : ""}. This is raw context for the separate build-feature workflow to consume later - do NOT start implementing anything from it now. The output below ends with the workflowId, the spec.json path, and the exact "sf workflow build-feature <workflowId>" command to run next - relay that command to the user verbatim, they'll need it. Here is the generated spec:\\n\\n\${report}\`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("build-feature", {
    description: "Run the full planner/architect/developer/tester/reviewer pipeline against a spec-context output, on its own branch, and open a PR",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /build-feature <spec-context workflowId or path to spec.json>", "warning");
        return;
      }
      interruptVoicePlayback();
      ctx.ui.notify(\`build-feature: \${args} (this runs a full dev pipeline in the background - can take a while, see \${process.env.SF_DASHBOARD_URL || "sf dashboard"})\`, "info");
      const { out, err, exitCode } = await new Promise<{ out: string; err: string; exitCode: number }>((resolve) => {
        const proc = spawn("sf", ["workflow", "build-feature", args], { cwd: ctx.cwd });
        let out = "";
        let errOut = "";
        proc.stdout.on("data", (chunk) => (out += chunk));
        proc.stderr.on("data", (chunk) => (errOut += chunk));
        proc.on("close", (code) => resolve({ out, err: errOut, exitCode: code ?? 1 }));
      });
      if (exitCode === 130) {
        ctx.ui.notify("build-feature was cancelled by the user from the dashboard.", "warning");
        pi.sendUserMessage(
          \`The build-feature run for "\${args}" was CANCELLED BY THE USER (from the dashboard's cancel button) before it finished. Whatever branch/commits/PR existed at that point are left as-is - do not retry or continue it, and do not assume it's ready. Just acknowledge the cancellation to the user.\\n\\n\${out}\`,
          { deliverAs: "followUp" },
        );
        return;
      }
      if (!out.trim()) {
        ctx.ui.notify(\`build-feature failed before producing anything: \${err.slice(0, 300) || "no output"}\`, "error");
        return;
      }
      // A nonzero exit can mean anything from "reviewer gates didn't fully
      // pass, PR is up" to "failed at the architect, nothing was built" - the
      // CLI output below says which (error/branch/PR lines), so relay it as-is.
      if (exitCode !== 0) {
        ctx.ui.notify(\`build-feature failed - see \${process.env.SF_DASHBOARD_URL || "sf dashboard"}\`, "warning");
      }
      pi.sendUserMessage(
        \`build-feature \${exitCode === 0 ? "succeeded" : "FAILED"} for "\${args}". Report the outcome to the user exactly as below (error, branch, PR). Do not try to fix, re-run or continue the pipeline yourself unless the user asks.\\n\\n\${out}\`,
        { deliverAs: "followUp" },
      );
    },
  });
}
`;

const DEFAULT_VOICE_PROFILE = `# Voice-only debate profile

This session is in voice mode. Treat the conversation as a natural spoken dialogue, not as a written report. Respond in English unless the user explicitly asks for another language.

Use short, natural sentences with clear punctuation and conversational rhythm. Prefer contractions and ordinary words. Keep responses concise enough to listen to comfortably. Ask focused follow-up questions when needed, challenge assumptions respectfully, and preserve the useful context of the debate.

Do not use markdown tables, code fences, long enumerations, raw URLs, file paths, or dense formatting unless the user explicitly asks for them. Do not narrate internal reasoning, tool calls, system behavior, TTS, audio playback, or voice-mode limitations. Do not tell the user that a request should not be handled in voice mode. Perform the task normally and silently, then explain the result in spoken-friendly language.

The user may provide text through terminal input or OS dictation, and dictation may contain transcription mistakes. Infer the intended meaning from context and ask only when the ambiguity matters. When the user asks for a requirement, specification, or artifact, use the full debate history and the requested workflow or command. Switch to detailed written output only when the user explicitly requests it.
`;

const DEFAULT_VOICE_EXTENSION = `// software-factory voice-only profile extension.
// Kokoro is intentionally external so the compiled sf binary stays portable.
// Configure SF_KOKORO_URL or SF_KOKORO_COMMAND before launching sf.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Child = ReturnType<typeof spawn>;
type VoiceContext = { ui: { notify(message: string, level: "info" | "warning" | "error"): void } };

const PROFILE = "voice-only";
const DEFAULT_KOKORO_URL = "http://127.0.0.1:8880/v1/audio/speech";
let queue: string[] = [];
let draining = false;
let generation = 0;
let synthesisAbort: AbortController | undefined;
let synthesisProcess: Child | undefined;
let playbackProcess: Child | undefined;

function isVoiceProfile(): boolean {
  return process.env.SF_PROFILE === PROFILE;
}

function killProcess(child: Child | undefined): void {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the check and kill.
  }
}

function stopAudio(): void {
  generation++;
  queue = [];
  synthesisAbort?.abort();
  killProcess(synthesisProcess);
  killProcess(playbackProcess);
}

function speechText(message: unknown): string | undefined {
  const value = message as {
    role?: string;
    stopReason?: string;
    content?: unknown;
  };
  if (value.role !== "assistant" || value.stopReason === "toolUse") return undefined;

  const blocks = Array.isArray(value.content) ? value.content : [{ type: "text", text: value.content }];
  if (blocks.some((block) => {
    const item = block as { type?: string };
    return item.type === "toolCall" || item.type === "tool_use" || item.type === "functionCall";
  })) return undefined;

  const text = blocks
    .filter((block) => (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\\n")
    .trim();
  if (!text) return undefined;

  return text
    .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, " ")
    .replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, "$1")
    .replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, "$1")
    .replace(/[#*_~\`]/g, "")
    .replace(/^\\s*[-*>]\\s+/gm, "")
    .replace(/\\s+/g, " ")
    .trim();
}

function audioPath(): string {
  return join(tmpdir(), "sf-kokoro-" + randomUUID() + ".wav");
}

async function synthesizeWithHttp(text: string, file: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(process.env.SF_KOKORO_URL || DEFAULT_KOKORO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.SF_KOKORO_MODEL || "kokoro",
      voice: process.env.SF_KOKORO_VOICE || "af_heart",
      input: text,
      response_format: "wav",
      speed: Number(process.env.SF_KOKORO_SPEED || "1"),
    }),
    signal,
  });
  if (!response.ok) throw new Error("Kokoro HTTP " + response.status + " " + (await response.text()).slice(0, 200));
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

async function synthesizeWithCommand(text: string, file: string, signal: AbortSignal): Promise<void> {
  const command = process.env.SF_KOKORO_COMMAND;
  if (!command) throw new Error("Kokoro is not configured. Set SF_KOKORO_URL or SF_KOKORO_COMMAND.");

  const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
  synthesisProcess = child;
  const output: Buffer[] = [];
  let errorOutput = "";
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      killProcess(child);
      finish(new Error("voice synthesis cancelled"));
    };
    child.stdout?.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (signal.aborted) return finish(new Error("voice synthesis cancelled"));
      if (code !== 0) return finish(new Error(errorOutput.trim() || "Kokoro command exited " + code));
      if (!output.length) return finish(new Error("Kokoro command produced no audio"));
      writeFileSync(file, Buffer.concat(output));
      finish();
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      child.stdin?.write(text);
      child.stdin?.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  if (synthesisProcess === child) synthesisProcess = undefined;
}

async function synthesize(text: string, file: string, signal: AbortSignal): Promise<void> {
  if (process.env.SF_KOKORO_COMMAND) return synthesizeWithCommand(text, file, signal);
  return synthesizeWithHttp(text, file, signal);
}

function playerCommand(file: string): [string, string[]] {
  const player = process.env.SF_AUDIO_PLAYER || (process.platform === "darwin" ? "afplay" : process.platform === "linux" ? "ffplay" : "");
  if (!player) throw new Error("No audio player configured. Set SF_AUDIO_PLAYER.");
  if (process.env.SF_AUDIO_PLAYER) return [player, [file]];
  return process.platform === "darwin"
    ? [player, [file]]
    : [player, ["-nodisp", "-autoexit", "-loglevel", "quiet", file]];
}

async function play(file: string, signal: AbortSignal): Promise<void> {
  const [command, args] = playerCommand(file);
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  playbackProcess = child;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      killProcess(child);
      finish(new Error("voice playback cancelled"));
    };
    let errorOutput = "";
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (signal.aborted) return finish(new Error("voice playback cancelled"));
      if (code !== 0) return finish(new Error(errorOutput.trim() || "audio player exited " + code));
      finish();
    });
    signal.addEventListener("abort", abort, { once: true });
  });
  if (playbackProcess === child) playbackProcess = undefined;
}

function reportFailure(ctx: VoiceContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[sf voice] " + message);
  try {
    ctx.ui.notify("Voice output unavailable: " + message, "error");
  } catch {
    // Text interaction must continue even when the UI is already shutting down.
  }
}

async function drain(ctx: VoiceContext): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const itemGeneration = generation;
      const text = queue.shift()!;
      const file = audioPath();
      const controller = new AbortController();
      synthesisAbort = controller;
      try {
        await synthesize(text, file, controller.signal);
        if (itemGeneration !== generation) continue;
        await play(file, controller.signal);
      } catch (error) {
        if (itemGeneration === generation && !controller.signal.aborted) reportFailure(ctx, error);
      } finally {
        if (synthesisAbort === controller) synthesisAbort = undefined;
        try { unlinkSync(file); } catch { /* file was not created */ }
      }
    }
  } finally {
    draining = false;
  }
}

export default function (pi: ExtensionAPI) {
  const onVoiceInterrupt = () => stopAudio();

  pi.on("session_start", () => {
    process.on("sf_voice_interrupt", onVoiceInterrupt);
  });

  pi.on("message_end", (event, ctx) => {
    if (!isVoiceProfile()) return;
    const text = speechText(event.message);
    if (!text) return;
    queue.push(text);
    void drain(ctx);
  });

  pi.on("input", (event) => {
    if (!isVoiceProfile() || event.source === "extension") return;
    stopAudio();
    if (/^\\/(stop|cancel)(\\s|$)/i.test(event.text)) return;
  });

  pi.on("tool_execution_start", () => {
    if (isVoiceProfile()) stopAudio();
  });

  pi.on("session_shutdown", () => {
    if (isVoiceProfile()) stopAudio();
    process.off("sf_voice_interrupt", onVoiceInterrupt);
  });

  pi.registerCommand("voice-stop", {
    description: "Stop Kokoro voice playback and clear queued speech",
    handler: async (_args, ctx) => {
      if (!isVoiceProfile()) return;
      stopAudio();
      ctx.ui.notify("Voice playback stopped.", "info");
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
  mkdirSync(join(PROFILES_DIR, "voice-only"), { recursive: true });
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
  if (!existsSync(VOICE_EXTENSION_FILE)) {
    writeFileSync(VOICE_EXTENSION_FILE, DEFAULT_VOICE_EXTENSION);
  }
  if (!existsSync(VOICE_PROFILE_FILE)) {
    writeFileSync(VOICE_PROFILE_FILE, DEFAULT_VOICE_PROFILE);
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
