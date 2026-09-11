import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROFILES_DIR, readBaseAgentPrompt } from "./home";

function profileAgentFile(name: string): string {
  return join(PROFILES_DIR, name, "AGENT.md");
}

export function listProfiles(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export class ProfileNotFoundError extends Error {
  constructor(
    public readonly profile: string,
    public readonly available: string[],
  ) {
    super(`Profile "${profile}" not found in ${PROFILES_DIR} (expected ${profileAgentFile(profile)})`);
  }
}

/**
 * Resolves the full system prompt: the base AGENT.md, plus the named
 * profile's AGENT.md appended on top when a profile is given.
 */
export function resolveSystemPrompt(profile?: string): string {
  const parts = [readBaseAgentPrompt()];

  if (profile) {
    const path = profileAgentFile(profile);
    if (!existsSync(path)) {
      throw new ProfileNotFoundError(profile, listProfiles());
    }
    parts.push(readFileSync(path, "utf-8").trim());
  }

  return parts.filter(Boolean).join("\n\n");
}
