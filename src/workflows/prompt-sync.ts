import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = ".defaults-manifest.json";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readManifest(promptsDir: string): Record<string, string> {
  const path = join(promptsDir, MANIFEST_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeManifest(promptsDir: string, manifest: Record<string, string>): void {
  writeFileSync(join(promptsDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export interface PromptSyncResult {
  created: string[];
  updated: string[];
  skipped: { file: string; reason: string }[];
}

/**
 * Brings an installed workflow's prompts/*.md up to date with the defaults
 * shipped in this build - the prompt-file equivalent of migrateConfigFile()
 * for config.json. A file is only touched when it's missing, or when it is
 * still byte-for-byte the default this same install last wrote (tracked in
 * .defaults-manifest.json next to the prompts). A file the user edited by
 * hand never matches its recorded hash, so it's always left alone and
 * reported as skipped instead of silently overwritten - unless `force` is
 * set, which overwrites every differing file regardless of the manifest
 * (needed on the very first sync ever run against an install, since there's
 * no recorded history yet to tell an old shipped default apart from a hand
 * edit - every existing file looks equally "unknown").
 */
export function syncDefaultPrompts(promptsDir: string, defaults: Record<string, string>, opts: { force?: boolean } = {}): PromptSyncResult {
  mkdirSync(promptsDir, { recursive: true });
  const manifest = readManifest(promptsDir);
  const result: PromptSyncResult = { created: [], updated: [], skipped: [] };

  for (const [file, content] of Object.entries(defaults)) {
    const path = join(promptsDir, file);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      manifest[file] = hash(content);
      result.created.push(file);
      continue;
    }

    const onDisk = readFileSync(path, "utf-8");
    if (onDisk === content) {
      manifest[file] = hash(content);
      continue;
    }

    const lastShippedHash = manifest[file];
    if (opts.force || (lastShippedHash && lastShippedHash === hash(onDisk))) {
      writeFileSync(path, content);
      manifest[file] = hash(content);
      result.updated.push(file);
    } else {
      result.skipped.push({ file, reason: "locally modified - left as-is (rerun with --force to overwrite anyway)" });
    }
  }

  writeManifest(promptsDir, manifest);
  return result;
}
