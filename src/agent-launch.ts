import { DEFAULT_EXTENSION_FILE, PROMPT_ENGINEER_EXTENSION_FILE, VOICE_EXTENSION_FILE } from "./home";

/**
 * Isolation flags so a launched session only ever sees software-factory's own
 * config, never the user's global ~/AGENTS.md, ~/.claude/CLAUDE.md, or
 * globally installed skills/extensions/plugins.
 */
export function piIsolationArgs(): string[] {
  return ["--no-context-files", "--no-skills", "--no-extensions"];
}

export function claudeIsolationArgs(): string[] {
  return ["--safe-mode"];
}

export function piExtensionArgs(profile?: string): string[] {
  const args = ["-e", DEFAULT_EXTENSION_FILE];
  if (profile === "voice-only") args.push("-e", VOICE_EXTENSION_FILE);
  if (profile === "prompt-engineer") args.push("-e", PROMPT_ENGINEER_EXTENSION_FILE);
  return args;
}
