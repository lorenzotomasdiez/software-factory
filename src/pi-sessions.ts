import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Mirrors pi's own getDefaultSessionDirPath (dist/core/session-manager.js in
 * @earendil-works/pi-coding-agent, not exported publicly): resolve cwd to an
 * absolute path, strip the leading slash, replace remaining path separators
 * and colons with dashes, and wrap the result in "--".
 */
export function piSessionDirFor(cwd: string, agentDir = join(homedir(), ".pi", "agent")): string {
  const resolvedCwd = resolve(cwd);
  const safe = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/**
 * Finds the transcript file pi wrote for a given (cwd, sessionId) pair.
 * pi names transcript files `<iso-timestamp>_<sessionId>.jsonl`, not just
 * `<sessionId>.jsonl`, so this matches by suffix. Returns null if the
 * session directory or a matching file doesn't exist (e.g. the pi process
 * crashed before writing anything).
 */
export function findTranscriptPath(cwd: string, sessionId: string): string | null {
  const dir = piSessionDirFor(cwd);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f === `${sessionId}.jsonl` || f.endsWith(`_${sessionId}.jsonl`));
  if (!files.length) return null;
  files.sort().reverse();
  return join(dir, files[0]);
}
