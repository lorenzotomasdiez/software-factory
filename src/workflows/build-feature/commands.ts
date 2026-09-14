import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildFeatureConfig } from "./config";

/** Per-repo override file, read (never written) from the target repo root. */
export const REPO_OVERRIDE_FILE = join(".sf", "build-feature.json");

export interface ResolvedCommands {
  buildCommand: string;
  testCommand: string;
  baseBranch: string;
  /** Where each value came from, for the dashboard/report - never guessed silently. */
  source: { buildCommand: string; testCommand: string; baseBranch: string };
}

interface RepoOverride {
  buildCommand?: string;
  testCommand?: string;
  baseBranch?: string;
}

function readRepoOverride(repoCwd: string): RepoOverride {
  const path = join(repoCwd, REPO_OVERRIDE_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RepoOverride;
  } catch (err) {
    throw new Error(`build-feature: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Picks build/test commands from the files the repo actually has. The
 * build-feature config is global (one file for every repo), so a fixed
 * default like "bun test" is wrong for any non-bun project and makes every
 * developer/tester gate fail mechanically no matter what the agents do.
 */
export function detectCommands(repoCwd: string): { buildCommand: string; testCommand: string } | null {
  const has = (file: string) => existsSync(join(repoCwd, file));

  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const runner = has("uv.lock") ? "uv run " : has("poetry.lock") ? "poetry run " : "";
    const python = runner ? "python" : "python3";
    return {
      // Byte-compiles every .py file (catches syntax errors), skipping virtualenvs and caches.
      buildCommand: `${runner}${python} -m compileall -q -x '/(\\.venv|venv|node_modules|\\.git|__pycache__)/' .`,
      testCommand: `${runner}${python} -m pytest -q`,
    };
  }

  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(join(repoCwd, "package.json"), "utf-8")).scripts ?? {}) as Record<string, string>;
    } catch {
      // unreadable package.json - fall through to lockfile/tsconfig based defaults
    }
    const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const exec = pm === "bun" ? "bunx" : pm === "pnpm" ? "pnpm exec" : pm === "yarn" ? "yarn" : "npx";
    const buildCommand = scripts.build ? `${pm} run build` : has("tsconfig.json") ? `${exec} tsc --noEmit` : null;
    const testCommand = scripts.test ? `${pm} run test` : pm === "bun" ? "bun test" : null;
    if (buildCommand && testCommand) return { buildCommand, testCommand };
    return null;
  }

  if (has("Cargo.toml")) return { buildCommand: "cargo build", testCommand: "cargo test" };
  if (has("go.mod")) return { buildCommand: "go build ./...", testCommand: "go test ./..." };

  return null;
}

/**
 * Resolution order, most specific first: the target repo's own
 * .sf/build-feature.json, then an explicit (non-"auto") value in the global
 * config, then detection from the repo's files. Fails loudly if nothing
 * applies instead of running a command that can never pass.
 */
export function resolveCommands(repoCwd: string, cfg: BuildFeatureConfig): ResolvedCommands {
  const override = readRepoOverride(repoCwd);
  const detected = detectCommands(repoCwd);

  const pick = (key: "buildCommand" | "testCommand"): { value: string; source: string } => {
    const fromRepo = override[key]?.trim();
    if (fromRepo) return { value: fromRepo, source: REPO_OVERRIDE_FILE };
    const fromConfig = cfg[key]?.trim();
    if (fromConfig && fromConfig !== "auto") return { value: fromConfig, source: "config.json" };
    if (detected) return { value: detected[key], source: "auto-detected" };
    throw new Error(
      `build-feature: couldn't figure out a ${key} for ${repoCwd} (no pyproject.toml/package.json/Cargo.toml/go.mod with usable scripts). ` +
        `Add ${join(repoCwd, REPO_OVERRIDE_FILE)} with {"buildCommand": "...", "testCommand": "..."}.`,
    );
  };

  const build = pick("buildCommand");
  const test = pick("testCommand");
  const repoBranch = override.baseBranch?.trim();
  return {
    buildCommand: build.value,
    testCommand: test.value,
    baseBranch: repoBranch || cfg.baseBranch,
    source: { buildCommand: build.source, testCommand: test.source, baseBranch: repoBranch ? REPO_OVERRIDE_FILE : "config.json" },
  };
}
