import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKTREES_DIR } from "./config";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(cmd: string[], cwd: string): Promise<ExecResult> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Runs an arbitrary shell command string (build/test commands are
 * user-configured, not a fixed argv) in `cwd`, returning whether it exited 0.
 * This - not any agent's self-report - is the deterministic gate.
 */
export async function runShell(command: string, cwd: string): Promise<ExecResult> {
  const proc = Bun.spawn({ cmd: ["/bin/sh", "-c", command], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Isolates every build-feature run in its own git worktree under
 * ~/.software-factory (never a sibling of the actual project, and never the
 * user's own checkout), so a developer agent with write+bash access can
 * never collide with work the user has in progress in the real repo.
 */
export async function setupWorktree(
  repoCwd: string,
  workflowId: string,
  preferredBranch: string,
  baseBranch: string,
): Promise<{ path: string; branch: string }> {
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const path = join(WORKTREES_DIR, workflowId);

  const fetch = await run(["git", "fetch", "origin", baseBranch], repoCwd);
  if (fetch.exitCode !== 0) throw new Error(`git fetch origin ${baseBranch} failed: ${fetch.stderr.trim()}`);

  const branch = await firstFreeBranchName(repoCwd, preferredBranch);

  const add = await run(["git", "worktree", "add", "-b", branch, path, `origin/${baseBranch}`], repoCwd);
  if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);

  return { path, branch };
}

/**
 * Re-running build-feature on the same spec must not collide with (or push
 * onto) an earlier run's branch, so a taken name gets a -2, -3... suffix -
 * checked both locally and on origin, since either one makes `worktree add -b`
 * or the later push fail.
 */
async function firstFreeBranchName(repoCwd: string, preferred: string): Promise<string> {
  const remote = await run(["git", "ls-remote", "--heads", "origin", `${preferred}*`], repoCwd);
  const remoteNames = new Set(
    remote.stdout
      .split("\n")
      .map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, ""))
      .filter(Boolean),
  );
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? preferred : `${preferred}-${n}`;
    const local = await run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], repoCwd);
    if (local.exitCode !== 0 && !remoteNames.has(candidate)) return candidate;
  }
}

export async function removeWorktree(repoCwd: string, worktreePath: string): Promise<void> {
  await run(["git", "worktree", "remove", worktreePath, "--force"], repoCwd);
}

/**
 * Files changed vs the base branch INCLUDING uncommitted and untracked work.
 * Agents never commit (the harness does, after the developer/tester loop), so
 * a commit-range diff (origin/base...HEAD) always looked empty mid-loop and
 * reported "no changes" for a developer that had edited a dozen files.
 */
export async function diffFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    run(["git", "diff", "--name-only", `origin/${baseBranch}`], worktreePath),
    run(["git", "ls-files", "--others", "--exclude-standard"], worktreePath),
  ]);
  const files = `${tracked.stdout}\n${untracked.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return [...new Set(files)];
}

export async function diffText(worktreePath: string, baseBranch: string, maxChars = 20000): Promise<string> {
  const res = await run(["git", "diff", `origin/${baseBranch}`], worktreePath);
  return res.stdout.length > maxChars ? `${res.stdout.slice(0, maxChars)}\n... (truncated)` : res.stdout;
}

export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await run(["git", "add", "-A"], worktreePath);
  const commit = await run(["git", "commit", "-m", message], worktreePath);
  return commit.exitCode === 0;
}

export async function pushBranch(worktreePath: string, branch: string): Promise<ExecResult> {
  return run(["git", "push", "-u", "origin", branch], worktreePath);
}

/** Creates the PR if none exists for this branch yet, else comments on the existing one. */
export async function ensurePr(
  repoCwd: string,
  branch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<{ url: string; created: boolean }> {
  const list = await run(["gh", "pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url"], repoCwd);
  const existingUrl = list.stdout.trim();
  const bodyFile = join(WORKTREES_DIR, `${branch.replace(/[/\\]/g, "_")}-body.md`);
  writeFileSync(bodyFile, body);
  try {
    if (existingUrl) {
      const comment = await run(["gh", "pr", "comment", branch, "--body-file", bodyFile], repoCwd);
      if (comment.exitCode !== 0) throw new Error(`gh pr comment failed: ${comment.stderr.trim()}`);
      return { url: existingUrl, created: false };
    }
    const create = await run(["gh", "pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body-file", bodyFile], repoCwd);
    if (create.exitCode !== 0) throw new Error(`gh pr create failed: ${create.stderr.trim()}`);
    return { url: create.stdout.trim(), created: true };
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

/** Deletes a local branch that never received commits (the worktree must be removed first). */
export async function deleteBranch(repoCwd: string, branch: string): Promise<void> {
  await run(["git", "branch", "-D", branch], repoCwd);
}
