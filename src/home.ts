import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT_DIR = join(homedir(), ".software-factory");
export const AGENT_FILE = join(ROOT_DIR, "AGENT.md");
export const CONFIG_FILE = join(ROOT_DIR, "config.json");
export const PROFILES_DIR = join(ROOT_DIR, "profiles");
export const EXTENSIONS_DIR = join(ROOT_DIR, "extensions");
export const HOOKS_DIR = join(ROOT_DIR, "hooks");

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

  if (!existsSync(AGENT_FILE)) {
    writeFileSync(AGENT_FILE, DEFAULT_AGENT_MD);
  }
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
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
