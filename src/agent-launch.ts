import { DEFAULT_EXTENSION_FILE } from "./home";

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

export function piExtensionArgs(): string[] {
  return ["-e", DEFAULT_EXTENSION_FILE];
}
