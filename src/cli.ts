#!/usr/bin/env bun
import { type AgentDefaults, AGENT_FILE, DEFAULT_EXTENSION_FILE, ROOT_DIR, ensureHome, readConfig } from "./home";
import { ProfileNotFoundError, listProfiles, resolveSystemPrompt } from "./profiles";
import { DEFAULT_DASHBOARD_PORT, ensureDashboardRunning, startDashboard } from "./dashboard";
import { claudeIsolationArgs, piExtensionArgs, piIsolationArgs } from "./agent-launch";
import { runBuildFeature } from "./workflows/build-feature";
import { ensureBuildFeatureConfig, syncBuildFeaturePrompts } from "./workflows/build-feature/config";
import type { PromptSyncResult } from "./workflows/prompt-sync";
import { runScoutContext } from "./workflows/scout-context";
import { ensureScoutContextConfig, syncScoutContextPrompts } from "./workflows/scout-context/config";
import { runSpecContext } from "./workflows/spec-context";
import { ensureSpecContextConfig, syncSpecContextPrompts } from "./workflows/spec-context/config";
import { stripWrappingQuotes } from "./workflows/work-title";
import { startVoiceRuntime } from "./voice-runtime";

const AGENTS = {
  claude: "claude",
  pi: "pi",
} as const;

type AgentName = keyof typeof AGENTS;

function isAgentName(value: string): value is AgentName {
  return value in AGENTS;
}

function printUsage(): void {
  console.log(`sf - launch claude or pi from any folder with a shared, editable system prompt

Usage:
  sf <agent> [--profile <name>] [-- ...args passed to the agent]
  sf profiles
  sf dashboard [--port <n>]
  sf workflow scout-context "<topic>"
  sf workflow spec-context "<task description>"
  sf workflow build-feature <spec-json-path-or-workflowId>
  sf workflow sync-prompts [--force]
  sf --help

Agents:
  claude    Launch Claude Code in the current directory
  pi        Launch Pi in the current directory

Workflows:
  scout-context   Deterministic multi-agent recon: spawns read-only scout
                  agents in parallel (structure, data flow, conventions),
                  merges their findings, and prints only the final report.
                  Runs in the background from inside \`sf pi\` via
                  /scout-context <topic>, or standalone via the CLI above.
                  Traced in the dashboard as one workflow with a lane per
                  scout.

  spec-context    Deterministic multi-agent spec generation: a planner picks
                  which sections apply (requirements, interfaces, constraints,
                  acceptance, edge_cases), a different model writes each
                  section in parallel, and a lead reviewer - on a model that
                  wrote no section - merges everything into one spec.md +
                  spec.json, gated by self-consistency checks (every id
                  survives, every ref resolves). Runs in the background from
                  inside \`sf pi\` via /spec-context <task>, or standalone via
                  the CLI above. Traced in the dashboard as one workflow with
                  a lane per section agent.

  build-feature   ADW-style pipeline that takes a spec-context output and
                  actually builds it: planner -> architect -> developer <->
                  tester (tester failures route back to the developer as
                  concrete correction) -> reviewer. Runs in an isolated git
                  worktree/branch under ~/.software-factory (never your own
                  checkout), pushes the branch, and opens/updates a GitHub PR
                  with a full spec-item coverage matrix. Pass/fail is always
                  mechanical (a real build command, a real test command,
                  self-consistency checks) - never an LLM's opinion of its
                  own work. Takes a spec-context workflowId or a direct path
                  to a spec.json.

  sync-prompts    Updates every workflow's installed prompts/*.md to the
                  defaults shipped in this build of sf. A file is only
                  touched when it's missing or still byte-for-byte the
                  default this install last wrote (tracked in
                  prompts/.defaults-manifest.json) - a prompt you edited by
                  hand is always left alone and reported as skipped instead.
                  Pass --force to overwrite skipped files anyway (also
                  needed the very first time this runs against an existing
                  install, since there's no recorded history yet to tell an
                  old shipped default apart from a hand edit).
                  Never runs automatically - always explicit, so local edits
                  stay untouched until you choose to sync.

Options:
  --profile <name>   Optional add-on profile, appended on top of the base prompt
                      voice-only adds asynchronous Kokoro TTS for assistant replies
                      prompt-engineer engineers prompts from a local knowledge base
                      and copies the <improved_prompt> block to the clipboard

Voice-only setup:
  SF_KOKORO_URL       Kokoro OpenAI-compatible endpoint (default: http://127.0.0.1:8880/v1/audio/speech)
  SF_KOKORO_COMMAND   Alternative local command; receives text on stdin and writes audio to stdout
  SF_AUDIO_PLAYER     Optional player executable override (macOS defaults to afplay)
  Automatic Kokoro uses localhost port 49637, pinned uv/package/model hashes,
  and stops its local process when the Pi session exits.

Prompt-engineer setup:
  SF_PROMPT_ENGINEER_SOURCE   Repo to resync the knowledge base from on every
                               launch (default: ~/projects/prompt-engineer);
                               every top-level *.md file there except
                               AGENTS.md/CLAUDE.md is copied in as a guide
  SF_CLIPBOARD_COMMAND        Override clipboard command (default: pbcopy on
                               macOS, xclip on Linux)

Observability:
  Every \`sf claude\`/\`sf pi\` launch auto-starts a local event dashboard
  (default http://localhost:${DEFAULT_DASHBOARD_PORT}) if one isn't already running,
  and prints its URL before handing off to the agent.
  Run \`sf dashboard\` yourself to open it in the foreground.

Config lives in ${ROOT_DIR}:
  AGENT.md            base system prompt, always applied
  profiles/<name>/AGENT.md   optional add-on, applied with --profile <name>
  profiles/prompt-engineer/knowledge/   resynced guide files (read-only, regenerated)
  config.json         harness config, incl. default --provider/--model per agent
  extensions/default.ts       observability extension
  extensions/voice-only.ts    Kokoro TTS extension for the voice-only profile
  extensions/prompt-engineer.ts   clipboard-copy extension for the prompt-engineer profile
  hooks/              reserved for future harness hooks
  events/             per-session JSONL event trace, read by \`sf dashboard\`
  workflows/scout-context/config.json   models/scouts/reviewer registry
  workflows/scout-context/prompts/*.md  per-agent prompts (editable)
  workflows/scout-context/runs/<id>/report.md   one report per run
  workflows/spec-context/config.json    models/planner/sections/reviewer registry
  workflows/spec-context/prompts/*.md   per-agent prompts (editable)
  workflows/spec-context/runs/<id>/spec.md, spec.json   one spec per run
  workflows/build-feature/config.json   models/buildCommand/testCommand/baseBranch registry
  workflows/build-feature/prompts/*.md  per-agent prompts (editable)
  workflows/build-feature/worktrees/<id>/   isolated git worktree per run
  workflows/build-feature/runs/<id>/report.md   one report per run

Examples:
  sf claude
  sf pi --profile backend-reviewer
  sf claude -- "summarize this repo"`);
}

function parseArgs(rest: string[]): { profile: string | undefined; passthrough: string[] } {
  let profile: string | undefined;
  const passthrough: string[] = [];
  let sawSeparator = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!sawSeparator && arg === "--") {
      // "--" separates sf's own flags from args meant for the child agent;
      // drop it rather than forwarding it, since the child's own arg parser
      // may treat a bare "--" as ending ITS flag parsing too.
      sawSeparator = true;
      continue;
    }
    if (!sawSeparator && arg === "--profile") {
      const value = rest[i + 1];
      if (!value) {
        console.error("sf: --profile requires a value");
        process.exit(1);
      }
      profile = value;
      i++;
      continue;
    }
    passthrough.push(arg);
  }
  return { profile, passthrough };
}

/** Injects config-file provider/model defaults, unless the user already passed their own. */
function buildDefaultArgs(defaults: AgentDefaults, passthrough: string[]): string[] {
  const args: string[] = [];
  if (defaults.provider && !passthrough.includes("--provider")) {
    args.push("--provider", defaults.provider);
  }
  if (defaults.model && !passthrough.includes("--model")) {
    args.push("--model", defaults.model);
  }
  return args;
}

/** Reads the value following `flag` in args, if present. */
function extractFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

/**
 * process.argv[1] is always the entrypoint path (Bun.main), whether that's
 * src/cli.ts under `bun run` or the virtual bunfs path in a compiled binary.
 * Strip it so both forms yield just the user-supplied args.
 */
function getArgs(): string[] {
  const argv = process.argv.slice(1);
  if (argv[0] === Bun.main) {
    return argv.slice(1);
  }
  return argv;
}

async function main(): Promise<void> {
  const args = getArgs();
  const first = args[0];

  if (!first || first === "--help" || first === "-h") {
    printUsage();
    process.exit(0);
  }

  ensureHome();

  if (first === "profiles") {
    for (const name of listProfiles()) console.log(name);
    process.exit(0);
  }

  if (first === "agent") {
    console.log(AGENT_FILE);
    process.exit(0);
  }

  if (first === "workflow") {
    const [name, ...rest] = args.slice(1);
    try {
      if (name === "sync-prompts") {
        const force = rest.includes("--force");
        ensureScoutContextConfig();
        ensureSpecContextConfig();
        ensureBuildFeatureConfig();
        const results: [string, PromptSyncResult][] = [
          ["scout-context", syncScoutContextPrompts({ force })],
          ["spec-context", syncSpecContextPrompts({ force })],
          ["build-feature", syncBuildFeaturePrompts({ force })],
        ];
        let anyProblem = false;
        for (const [workflow, result] of results) {
          console.log(`${workflow}:`);
          if (result.created.length) console.log(`  created: ${result.created.join(", ")}`);
          if (result.updated.length) console.log(`  updated: ${result.updated.join(", ")}`);
          if (result.skipped.length) {
            anyProblem = true;
            for (const { file, reason } of result.skipped) console.log(`  skipped: ${file} (${reason})`);
          }
          if (!result.created.length && !result.updated.length && !result.skipped.length) console.log("  up to date");
        }
        if (anyProblem) console.log("\nsf: some prompts were skipped because they no longer match the shipped default - rerun with --force to overwrite them anyway, or update those by hand.");
        process.exit(0);
      }
      if (name === "scout-context") {
        const topic = stripWrappingQuotes(rest.join(" "));
        if (!topic) {
          console.error('sf: usage: sf workflow scout-context "<topic>"');
          process.exit(1);
        }
        const result = await runScoutContext(topic);
        console.log(result.report);
        if (result.cancelled) {
          console.log("\nsf: scout-context CANCELLED_BY_USER");
          process.exit(130);
        }
        process.exit(result.ok ? 0 : 1);
      }
      if (name === "spec-context") {
        const topic = stripWrappingQuotes(rest.join(" "));
        if (!topic) {
          console.error('sf: usage: sf workflow spec-context "<task description>"');
          process.exit(1);
        }
        const result = await runSpecContext(topic);
        console.log(result.markdown);
        if (result.cancelled) {
          console.log("\nsf: spec-context CANCELLED_BY_USER");
          process.exit(130);
        }
        console.log(`\nsf: spec-context ${result.ok ? "succeeded" : "finished with unresolved gate failures"}`);
        console.log(`  title:      ${result.title ? `${result.title} (${result.type})` : "(not named - build-feature will name it from the spec)"}`);
        console.log(`  workflowId: ${result.workflowId}`);
        console.log(`  spec.json:  ${result.specJsonPath}`);
        console.log(`  next: sf workflow build-feature ${result.workflowId}`);
        process.exit(result.ok ? 0 : 1);
      }
      if (name === "build-feature") {
        const specInput = stripWrappingQuotes(rest.join(" "));
        if (!specInput) {
          console.error("sf: usage: sf workflow build-feature <spec-json-path-or-workflowId>");
          process.exit(1);
        }
        const result = await runBuildFeature(specInput);
        if (result.cancelled) {
          console.log("sf: build-feature CANCELLED_BY_USER");
          console.log(`  report: ${result.reportPath}`);
          process.exit(130);
        }
        console.log(`sf: build-feature ${result.ok ? "succeeded" : "failed"}`);
        if (result.title) console.log(`  title: ${result.title}`);
        if (result.error) console.log(`  error: ${result.error}`);
        console.log(`  branch: ${result.branch || "(none - nothing was committed)"}`);
        if (result.prUrl) console.log(`  PR: ${result.prUrl}`);
        console.log(`  report: ${result.reportPath}`);
        process.exit(result.ok ? 0 : 1);
      }
    } catch (err) {
      // Any thrown error here (bad input, missing spec.json, git/gh failures,
      // invalid config) would otherwise surface as a raw uncaught-exception
      // stack trace pointing at bundled/minified line numbers - useless to a
      // human. Print just the message instead.
      console.error(`sf: workflow "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.error(`sf: unknown workflow "${name}". Expected one of: scout-context, spec-context, build-feature, sync-prompts`);
    process.exit(1);
  }

  if (first === "dashboard") {
    const rest = args.slice(1);
    const internal = rest.includes("--internal-serve");
    const port = Number(extractFlagValue(rest, "--port") ?? DEFAULT_DASHBOARD_PORT);
    startDashboard(port);
    if (!internal) {
      console.log(`sf dashboard running at http://localhost:${port} (Ctrl+C to stop)`);
    }
    return; // keep the process alive; Bun.serve holds the event loop open
  }

  if (!isAgentName(first)) {
    console.error(`sf: unknown agent "${first}". Expected one of: ${Object.keys(AGENTS).join(", ")}`);
    process.exit(1);
  }

  const { profile, passthrough } = parseArgs(args.slice(1));

  let systemPrompt: string;
  try {
    systemPrompt = resolveSystemPrompt(profile);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      console.error(`sf: ${err.message}`);
      console.error(`Available profiles: ${err.available.join(", ") || "(none)"}`);
      process.exit(1);
    }
    throw err;
  }

  const config = readConfig();
  const defaults: AgentDefaults = config.agents?.[first] ?? {};
  const defaultArgs = buildDefaultArgs(defaults, passthrough);

  // Isolate the launched session from the user's own global/project setup
  // (~/AGENTS.md, ~/CLAUDE.md, globally installed skills/extensions/plugins)
  // so `sf` only brings what software-factory itself configures.
  const isolationArgs = first === "pi" ? piIsolationArgs() : claudeIsolationArgs();
  const extensionArgs = first === "pi" ? piExtensionArgs(profile) : [];

  const childArgs = systemPrompt
    ? ["--append-system-prompt", systemPrompt, ...isolationArgs, ...defaultArgs, ...extensionArgs, ...passthrough]
    : [...isolationArgs, ...defaultArgs, ...extensionArgs, ...passthrough];
  const binary = AGENTS[first];

  const env: Record<string, string | undefined> = { ...process.env };
  if (first === "pi") {
    env.SF_PROFILE = profile ?? "default";
    const effectiveProvider = extractFlagValue(passthrough, "--provider") ?? defaults.provider;
    const effectiveModel = extractFlagValue(passthrough, "--model") ?? defaults.model;
    if (effectiveProvider) env.SF_PROVIDER = effectiveProvider;
    if (effectiveModel) env.SF_MODEL = effectiveModel;
  }

  let voiceRuntime: Awaited<ReturnType<typeof startVoiceRuntime>>;

  try {
    if (first === "pi" && profile === "voice-only") {
      try {
        voiceRuntime = await startVoiceRuntime();
        if (voiceRuntime) {
          env.SF_KOKORO_URL = voiceRuntime.url;
          env.SF_KOKORO_VOICE = process.env.SF_KOKORO_VOICE || "af_heart";
        }
      } catch (err) {
        console.error(`sf: Kokoro could not start. Text interaction will continue without audio.`);
        console.error(err instanceof Error ? err.message : err);
      }
    }

    const dashboardUrl = await ensureDashboardRunning();
    env.SF_DASHBOARD_URL = dashboardUrl;
    console.log(`🏭 sf observability: ${dashboardUrl}`);

    const proc = Bun.spawn({
      cmd: [binary, ...childArgs],
      stdio: ["inherit", "inherit", "inherit"],
      cwd: process.cwd(),
      env,
    });
    const exitCode = await proc.exited;
    await voiceRuntime?.stop();
    process.exit(exitCode);
  } catch (err) {
    await voiceRuntime?.stop();
    console.error(`sf: failed to launch "${binary}". Is it installed and on PATH?`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
