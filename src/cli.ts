#!/usr/bin/env bun
import { type AgentDefaults, AGENT_FILE, DEFAULT_EXTENSION_FILE, ROOT_DIR, ensureHome, readConfig } from "./home";
import { ProfileNotFoundError, listProfiles, resolveSystemPrompt } from "./profiles";

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
  sf --help

Agents:
  claude    Launch Claude Code in the current directory
  pi        Launch Pi in the current directory

Options:
  --profile <name>   Optional add-on profile, appended on top of the base prompt

Config lives in ${ROOT_DIR}:
  AGENT.md            base system prompt, always applied
  profiles/<name>/AGENT.md   optional add-on, applied with --profile <name>
  config.json         harness config, incl. default --provider/--model per agent
  extensions/         reserved for future harness extensions
  hooks/              reserved for future harness hooks

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
  const isolationArgs =
    first === "pi"
      ? ["--no-context-files", "--no-skills", "--no-extensions"]
      : ["--safe-mode"];
  const extensionArgs = first === "pi" ? ["-e", DEFAULT_EXTENSION_FILE] : [];

  const childArgs = systemPrompt
    ? ["--append-system-prompt", systemPrompt, ...isolationArgs, ...defaultArgs, ...extensionArgs, ...passthrough]
    : [...isolationArgs, ...defaultArgs, ...extensionArgs, ...passthrough];
  const binary = AGENTS[first];

  const env: Record<string, string> = { ...process.env };
  if (first === "pi") {
    env.SF_PROFILE = profile ?? "default";
    const effectiveProvider = extractFlagValue(passthrough, "--provider") ?? defaults.provider;
    const effectiveModel = extractFlagValue(passthrough, "--model") ?? defaults.model;
    if (effectiveProvider) env.SF_PROVIDER = effectiveProvider;
    if (effectiveModel) env.SF_MODEL = effectiveModel;
  }

  try {
    const proc = Bun.spawn({
      cmd: [binary, ...childArgs],
      stdio: ["inherit", "inherit", "inherit"],
      cwd: process.cwd(),
      env,
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  } catch (err) {
    console.error(`sf: failed to launch "${binary}". Is it installed and on PATH?`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
