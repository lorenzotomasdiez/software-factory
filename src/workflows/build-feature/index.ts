import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { piExtensionArgs, piIsolationArgs } from "../../agent-launch";
import { ensureDashboardRunning } from "../../dashboard";
import { EVENTS_DIR, readBaseAgentPrompt } from "../../home";
import { emitWorkflowEvent } from "../events";
import { promptTitle, renderTemplate } from "../scout-context/prompts";
import { RUNS_DIR as SPEC_RUNS_DIR } from "../spec-context/config";
import {
  ensureBuildFeatureConfig,
  loadBuildFeatureConfig,
  PROMPTS_DIR,
  resolveModel,
  RUNS_DIR,
  type AgentSpec,
  type BuildFeatureConfig,
} from "./config";
import {
  allSpecIds,
  architectGates,
  developerGates,
  extractJson,
  plannerGates,
  reviewerGates,
  testerGates,
  type ArchitectEnvelope,
  type DeveloperEnvelope,
  type PlannerEnvelope,
  type ReviewerEnvelope,
  type TesterEnvelope,
} from "./gates";
import { resolveCommands } from "./commands";
import { commitAll, deleteBranch, diffFiles, diffText, ensurePr, pushBranch, removeWorktree, runShell, setupWorktree } from "./git";
import { clearWorkflow, registerWorkflow, throwIfCancelled, trackChild, untrackChild, WorkflowCancelledError } from "../cancel";
import { watchAgent } from "../agent-watchdog";
import { branchNameFor, nameWorkFromSpec, readWorkMetaNextTo, stripWrappingQuotes, writeWorkMeta, type WorkName } from "../work-title";

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the harness killed the agent, with the reason - distinct from the agent failing on its own. */
  timedOut?: string;
}

type ToolMode = "readonly" | "full" | "none";

async function spawnPi(opts: {
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  cwd: string;
  workflowId: string;
  role: string;
  dashboardUrl: string;
  toolMode: ToolMode;
}): Promise<SpawnResult> {
  throwIfCancelled(opts.workflowId);
  emitWorkflowEvent(opts.workflowId, opts.role, "session_started", { sessionId: opts.sessionId, cwd: opts.cwd });
  const toolArgs = opts.toolMode === "readonly" ? ["--tools", "read,grep,find,ls"] : opts.toolMode === "none" ? ["--no-tools"] : [];
  const proc = Bun.spawn({
    cmd: [
      "pi",
      "--print",
      "--provider",
      opts.provider,
      "--model",
      opts.model,
      "--append-system-prompt",
      opts.systemPrompt,
      ...piIsolationArgs(),
      ...piExtensionArgs(),
      ...toolArgs,
      "--session-id",
      opts.sessionId,
      opts.prompt,
    ],
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SF_WORKFLOW_ID: opts.workflowId,
      SF_ROLE: opts.role,
      SF_PROFILE: "build-feature",
      SF_DASHBOARD_URL: opts.dashboardUrl,
      // See scout-context/index.ts's spawnPi for why this override matters.
      SF_PROVIDER: opts.provider,
      SF_MODEL: opts.model,
    },
  });

  trackChild(opts.workflowId, proc.pid);
  const stopWatchdog = watchAgent(proc, opts.workflowId, opts.role);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const timedOut = stopWatchdog();
  untrackChild(opts.workflowId, proc.pid);
  return { stdout, stderr, exitCode, timedOut };
}

function resolveSpecInput(input: string): { specPath: string; topic: string; name?: WorkName } {
  const directPath = existsSync(input) ? input : null;
  const specPath = directPath ?? join(SPEC_RUNS_DIR, input, "spec.json");
  if (!existsSync(specPath)) {
    throw new Error(`build-feature: no spec.json found (checked "${input}" as a path, and as a spec-context workflowId at ${specPath})`);
  }
  const meta = readWorkMetaNextTo(specPath);
  if (meta) return { specPath, topic: meta.topic || meta.title, name: { title: meta.title, type: meta.type } };

  // Not named yet (a spec from before spec-context named its work, or a
  // hand-written one): the raw request is kept only as context for the namer.
  let topic = input;
  const eventsPath = join(EVENTS_DIR, `${input}.jsonl`);
  if (!directPath && existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "workflow_start" && evt.data?.topic) {
          topic = stripWrappingQuotes(evt.data.topic);
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
  }
  return { specPath, topic };
}

/**
 * Names a spec that spec-context never named, from the spec's own content.
 * Persists the name next to spec-context's own runs so a re-run reuses it;
 * a hand-written spec.json elsewhere is never written next to.
 */
async function runNamer(
  cfg: BuildFeatureConfig,
  topic: string,
  specPath: string,
  specJson: string,
  workflowId: string,
  cwd: string,
  dashboardUrl: string,
): Promise<{ ok: true; name: WorkName } | { ok: false; error: string }> {
  const role = "namer";
  const { provider, model } = resolveModel(cfg, cfg.planner.modelKey);
  emitWorkflowEvent(workflowId, role, "scout_start", { angle: "Work namer", provider, model });
  const specMdPath = join(dirname(specPath), "spec.md");
  const result = await nameWorkFromSpec({
    topic,
    specJson,
    specMarkdown: existsSync(specMdPath) ? readFileSync(specMdPath, "utf-8") : undefined,
    retries: cfg.retries,
    run: (systemPrompt, prompt, attempt) =>
      spawnPi({ provider, model, systemPrompt, prompt, sessionId: `sf-build-${workflowId}-namer-${attempt}`, cwd, workflowId, role, dashboardUrl, toolMode: "none" }),
    onAttempt: (attempt, checks, error) => {
      if (checks) emitWorkflowEvent(workflowId, role, "gate_result", { attempt, checks });
      if (error) emitWorkflowEvent(workflowId, role, "scout_retry", { attempt, error });
    },
  });
  emitWorkflowEvent(workflowId, role, "scout_end", result.ok ? { ok: true, ...result.name } : { ok: false, error: result.error });
  if (result.ok && resolve(dirname(dirname(specPath))) === resolve(SPEC_RUNS_DIR)) {
    writeWorkMeta(dirname(specPath), { workflowId: basename(dirname(specPath)), topic, ...result.name });
  }
  return result;
}

interface RunContext {
  cfg: BuildFeatureConfig;
  basePrompt: string;
  workflowId: string;
  worktreePath: string;
  dashboardUrl: string;
  repoCwd: string;
  /** The user's original request, verbatim. */
  topic: string;
  /** The work's name - commit subject, PR title and report heading. */
  title: string;
  /** Whether the branch has real commits on the remote - no PR is attempted otherwise. */
  pushed: boolean;
}

async function runPhase<T>(
  ctx: RunContext,
  agent: AgentSpec,
  toolMode: ToolMode,
  vars: Record<string, string>,
  extraSystemPrompt: string,
  gate: (raw: unknown) => { name: string; ok: boolean; detail: string }[],
): Promise<{ ok: boolean; envelope?: T; error?: string; attempts: number }> {
  const template = readFileSync(join(PROMPTS_DIR, agent.promptFile), "utf-8");
  const instructionBody = renderTemplate(template, vars);
  const systemPrompt = [ctx.basePrompt, extraSystemPrompt, instructionBody].filter(Boolean).join("\n\n");
  const { provider, model } = resolveModel(ctx.cfg, agent.modelKey);

  emitWorkflowEvent(ctx.workflowId, agent.role, "scout_start", { angle: promptTitle(template), provider, model });

  let lastError = "";
  for (let attempt = 1; attempt <= ctx.cfg.retries + 1; attempt++) {
    // A fresh session per attempt: the full spec/plan context is re-rendered
    // into systemPrompt above and the correction is folded into the prompt
    // below, so a resumed session would add nothing but stale turns.
    const sessionId = `sf-build-${ctx.workflowId}-${agent.role}-${attempt}`;
    const prompt = attempt === 1 ? `Do the "${agent.role}" work now.` : `Your previous response failed validation:\n- ${lastError}\n\nFix it and re-emit ONLY the fenced json block.`;

    const result = await spawnPi({
      provider,
      model,
      systemPrompt,
      prompt,
      sessionId,
      cwd: ctx.worktreePath,
      workflowId: ctx.workflowId,
      role: agent.role,
      dashboardUrl: ctx.dashboardUrl,
      toolMode,
    });

    if (result.timedOut) {
      lastError = `agent stopped by the harness: ${result.timedOut}`;
      emitWorkflowEvent(ctx.workflowId, agent.role, "scout_retry", { attempt, error: lastError });
      continue;
    }
    if (result.exitCode !== 0) {
      lastError = readableAgentError(result.stderr) || `exited ${result.exitCode}`;
      emitWorkflowEvent(ctx.workflowId, agent.role, "scout_retry", { attempt, error: lastError });
      // A rejected request (bad model/feature combo, auth, unknown model) fails
      // identically on every attempt - retrying only burns time and hides the cause.
      if (isNonRetryableError(result.stderr)) break;
      continue;
    }

    try {
      const parsed = extractJson(result.stdout);
      const checks = gate(parsed);
      const failed = checks.filter((c) => !c.ok);
      emitWorkflowEvent(ctx.workflowId, agent.role, "gate_result", { attempt, checks });
      if (failed.length === 0) {
        emitWorkflowEvent(ctx.workflowId, agent.role, "scout_end", { ok: true, attempt });
        return { ok: true, envelope: parsed as T, attempts: attempt };
      }
      lastError = failed.map((f) => `${f.name}: ${f.detail}`).join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    emitWorkflowEvent(ctx.workflowId, agent.role, "scout_retry", { attempt, error: lastError });
  }

  emitWorkflowEvent(ctx.workflowId, agent.role, "scout_end", { ok: false, error: lastError });
  return { ok: false, error: lastError, attempts: ctx.cfg.retries + 1 };
}

/**
 * Pi dumps the provider's raw JSON error body to stderr, and the tail of it
 * (what used to be kept) cuts the actual message in half. Pull out the
 * provider's own "message" field when there is one.
 */
function readableAgentError(stderr: string): string {
  const text = stderr.trim();
  if (!text) return "";
  const messages = [...text.matchAll(/\\?"message\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  // Nested bodies go outer-generic -> inner-specific ("Provider returned error" -> the real reason).
  const message = messages.filter((m) => m.length > 0).at(-1);
  if (message) return message.slice(0, 500);
  return text.slice(-500);
}

function isNonRetryableError(stderr: string): boolean {
  return /invalid_request_error|invalid_request|not supported|authentication_error|permission_error|model_not_found|No endpoints found|\b40[13]\b/i.test(stderr);
}

export interface BuildFeatureResult {
  workflowId: string;
  ok: boolean;
  cancelled?: boolean;
  /** Why it isn't ok, in one readable line - surfaced by the CLI and the pi command. */
  error?: string;
  topic: string;
  /** Absent only when the work could not be named, which stops the run before any branch exists. */
  title?: string;
  branch: string;
  prUrl?: string;
  reportPath: string;
}

/**
 * The ADW-style pipeline: planner -> architect -> developer <-> tester
 * (looped, with the tester's failures routed back to the developer as
 * concrete correction, not blind re-prompting) -> reviewer. Everything runs
 * in a dedicated git worktree/branch under ~/.software-factory, never the
 * user's own checkout, and the only things that ever decide pass/fail are
 * mechanical: a real build command, a real test command, and self-consistency
 * checks against the spec - never an LLM's opinion of its own work.
 */
export async function runBuildFeature(specInput: string, cwd = process.cwd()): Promise<BuildFeatureResult> {
  ensureBuildFeatureConfig();
  const cfg = loadBuildFeatureConfig();
  const commands = resolveCommands(cwd, cfg);
  // From here on cfg carries the commands for THIS repo, so every consumer
  // (prompts, gates, diff base, PR base) agrees on one resolved value.
  cfg.buildCommand = commands.buildCommand;
  cfg.testCommand = commands.testCommand;
  cfg.baseBranch = commands.baseBranch;
  const { specPath, topic, name: existingName } = resolveSpecInput(specInput);
  let name = existingName;
  const spec = JSON.parse(readFileSync(specPath, "utf-8")) as Record<string, { id: string; text: string; refs?: string[] }[]>;
  const specJson = JSON.stringify(spec, null, 2);
  const mustCoverIds = [...(spec.requirements ?? []), ...(spec.acceptance ?? [])].map((i) => i.id);
  const specIds = allSpecIds(spec);

  const workflowId = randomUUID();
  registerWorkflow(workflowId);
  try {
    return await runPipeline();
  } catch (err) {
    if (err instanceof WorkflowCancelledError) {
      emitWorkflowEvent(workflowId, "orchestrator", "workflow_end", { ok: false, cancelled: true });
      const runDir = join(RUNS_DIR, workflowId);
      mkdirSync(runDir, { recursive: true });
      const reportPath = join(runDir, "report.md");
      writeFileSync(reportPath, `# build-feature: ${name?.title ?? topic}\n\n_Cancelled by the user before finishing._\n`);
      return { workflowId, ok: false, cancelled: true, topic, title: name?.title, branch: "", reportPath };
    }
    throw err;
  } finally {
    clearWorkflow(workflowId);
  }

  async function runPipeline(): Promise<BuildFeatureResult> {
  const basePrompt = readBaseAgentPrompt();
  const dashboardUrl = await ensureDashboardRunning();

  emitWorkflowEvent(workflowId, "orchestrator", "workflow_start", {
    topic,
    agents: 5,
    workflow: "build-feature",
    buildCommand: commands.buildCommand,
    testCommand: commands.testCommand,
    baseBranch: commands.baseBranch,
    commandSource: commands.source,
  });

  if (!name) {
    const named = await runNamer(cfg, topic, specPath, specJson, workflowId, cwd, dashboardUrl);
    if (!named.ok) {
      // Fail before any branch exists: a branch named after the raw request
      // ("feat/for-doing-phase-7-of-plan-md") is exactly what this prevents.
      const error = `could not name the work from the spec: ${named.error}`;
      const runDir = join(RUNS_DIR, workflowId);
      mkdirSync(runDir, { recursive: true });
      const reportPath = join(runDir, "report.md");
      writeFileSync(reportPath, `# build-feature: ${topic}\n\nStopped before creating a branch.\n\n## Error\n${error}\n`);
      emitWorkflowEvent(workflowId, "orchestrator", "workflow_end", { ok: false, reportPath, branch: "", error });
      return { workflowId, ok: false, error, topic, branch: "", reportPath };
    }
    name = named.name;
  }
  const { title } = name;
  emitWorkflowEvent(workflowId, "orchestrator", "workflow_title", { ...name, namedBy: existingName ? "spec-context" : "namer" });

  const { path: worktreePath, branch } = await setupWorktree(cwd, workflowId, branchNameFor(name), cfg.baseBranch);
  emitWorkflowEvent(workflowId, "orchestrator", "branch_created", { branch, worktreePath });

  const ctx: RunContext = { cfg, basePrompt, workflowId, worktreePath, dashboardUrl, repoCwd: cwd, topic, title, pushed: false };
  const roleSystemPrompt = (role: string) => `You are the ${role} inside software-factory's \`build-feature\` workflow, implementing a feature from a pre-generated spec.`;

  // 1. Planner
  const planResult = await runPhase<PlannerEnvelope>(
    ctx,
    cfg.planner,
    "readonly",
    { SPEC_JSON: specJson },
    roleSystemPrompt("planner"),
    (raw) => plannerGates(raw, mustCoverIds),
  );
  if (!planResult.ok || !planResult.envelope) {
    return finish(ctx, branch, false, `planner failed: ${planResult.error}`, specJson, "", "", "", "", false, false);
  }
  const planJson = JSON.stringify(planResult.envelope, null, 2);
  const planStepIds = planResult.envelope.steps.map((s) => s.id);

  // 2. Architect
  const archResult = await runPhase<ArchitectEnvelope>(
    ctx,
    cfg.architect,
    "readonly",
    { SPEC_JSON: specJson, PLAN_JSON: planJson },
    roleSystemPrompt("architect"),
    (raw) => architectGates(raw, planStepIds),
  );
  if (!archResult.ok || !archResult.envelope) {
    return finish(ctx, branch, false, `architect failed: ${archResult.error}`, specJson, planJson, "", "", "", false, false);
  }
  const architectureJson = JSON.stringify(archResult.envelope, null, 2);

  // 3. Developer <-> Tester loop: tester failures feed back into the
  // developer's next attempt as concrete correction, not a blind retry.
  let devEnvelope: DeveloperEnvelope | undefined;
  let testerEnvelope: TesterEnvelope | undefined;
  let buildOk = false;
  let testOk = false;
  let cycleError = "";

  const devTemplate = readFileSync(join(PROMPTS_DIR, cfg.developer.promptFile), "utf-8");
  const devSessionId = `sf-build-${workflowId}-developer`;
  const { provider: devProvider, model: devModel } = resolveModel(cfg, cfg.developer.modelKey);
  emitWorkflowEvent(workflowId, cfg.developer.role, "scout_start", { angle: promptTitle(devTemplate), provider: devProvider, model: devModel });

  const testerTemplate = readFileSync(join(PROMPTS_DIR, cfg.tester.promptFile), "utf-8");
  const testerSessionId = `sf-build-${workflowId}-tester`;
  const { provider: testerProvider, model: testerModel } = resolveModel(cfg, cfg.tester.modelKey);
  // Emitted when the tester actually first runs, not up front: it only ever
  // starts after a developer attempt passes its gates, and an early
  // scout_start made the dashboard show it "running" alongside the developer.
  let testerStarted = false;

  for (let cycle = 1; cycle <= cfg.retries + 1; cycle++) {
    const devInstructionBody = renderTemplate(devTemplate, {
      SPEC_JSON: specJson,
      PLAN_JSON: planJson,
      ARCHITECTURE_JSON: architectureJson,
      BUILD_COMMAND: cfg.buildCommand,
    });
    const devSystemPrompt = [basePrompt, roleSystemPrompt("developer"), devInstructionBody].filter(Boolean).join("\n\n");
    const devPrompt = cycle === 1 ? "Implement the plan now." : `Your previous attempt did not pass:\n- ${cycleError}\n\nYour earlier edits are still in the worktree - continue from there and fix it.`;

    const devResult = await spawnPi({
      provider: devProvider,
      model: devModel,
      systemPrompt: devSystemPrompt,
      prompt: devPrompt,
      sessionId: devSessionId,
      cwd: worktreePath,
      workflowId,
      role: cfg.developer.role,
      dashboardUrl,
      toolMode: "full",
    });

    if (devResult.timedOut) {
      cycleError = `you were stopped by the harness (${devResult.timedOut}) before finishing - finish the remaining steps, run the build, and end with the json summary`;
    }
    const actualDiffFiles = await diffFiles(worktreePath, cfg.baseBranch);
    const buildResult = await runShell(cfg.buildCommand, worktreePath);
    buildOk = buildResult.exitCode === 0;

    let devParsed: unknown;
    try {
      devParsed = extractJson(devResult.stdout);
      devEnvelope = devParsed as DeveloperEnvelope;
    } catch (err) {
      devParsed = undefined;
      if (!devResult.timedOut) cycleError = `developer produced no valid json summary: ${err instanceof Error ? err.message : String(err)}`;
    }
    const devChecks = developerGates(devParsed, actualDiffFiles, buildOk);
    const devFailed = devChecks.filter((c) => !c.ok);
    emitWorkflowEvent(workflowId, cfg.developer.role, "gate_result", { attempt: cycle, checks: devChecks });

    if (devFailed.length > 0) {
      const gateText = devFailed.map((f) => `${f.name}: ${f.detail}`).join("; ");
      const buildText = buildResult.exitCode !== 0 ? ` | build output: ${(buildResult.stderr.trim() || buildResult.stdout.trim()).slice(-800)}` : "";
      cycleError = devResult.timedOut ? `${cycleError} | ${gateText}${buildText}` : `${gateText}${buildText}`;
      emitWorkflowEvent(workflowId, cfg.developer.role, "scout_retry", { attempt: cycle, error: cycleError });
      continue; // give the tester nothing to check yet - retry the developer directly
    }

    // Tester: fresh view of the current diff each cycle, same session across cycles for continuity.
    const testerInstructionBody = renderTemplate(testerTemplate, {
      SPEC_JSON: specJson,
      DEV_SUMMARY: devEnvelope?.summary ?? "",
      TEST_COMMAND: cfg.testCommand,
    });
    const testerSystemPrompt = [basePrompt, roleSystemPrompt("tester"), testerInstructionBody].filter(Boolean).join("\n\n");
    const testerPrompt = testerStarted ? "The developer just applied a fix - re-verify." : "Verify the implementation now.";
    if (!testerStarted) {
      emitWorkflowEvent(workflowId, cfg.tester.role, "scout_start", { angle: promptTitle(testerTemplate), provider: testerProvider, model: testerModel });
      testerStarted = true;
    }

    const testerResult = await spawnPi({
      provider: testerProvider,
      model: testerModel,
      systemPrompt: testerSystemPrompt,
      prompt: testerPrompt,
      sessionId: testerSessionId,
      cwd: worktreePath,
      workflowId,
      role: cfg.tester.role,
      dashboardUrl,
      toolMode: "full",
    });

    const testResult = await runShell(cfg.testCommand, worktreePath);
    testOk = testResult.exitCode === 0;

    let testerParsed: unknown;
    try {
      testerParsed = extractJson(testerResult.stdout);
      testerEnvelope = testerParsed as TesterEnvelope;
    } catch {
      testerParsed = undefined;
    }
    const testerChecks = testerGates(testerParsed, testOk);
    const testerFailed = testerChecks.filter((c) => !c.ok);
    emitWorkflowEvent(workflowId, cfg.tester.role, "gate_result", { attempt: cycle, checks: testerChecks });

    if (testOk) {
      emitWorkflowEvent(workflowId, cfg.tester.role, "scout_end", { ok: true, attempt: cycle });
      emitWorkflowEvent(workflowId, cfg.developer.role, "scout_end", { ok: true, attempt: cycle });
      break;
    }

    cycleError = testerFailed.map((f) => `${f.name}: ${f.detail}`).join("; ") || testResult.stdout.trim().slice(-800) || testResult.stderr.trim().slice(-800);
    emitWorkflowEvent(workflowId, cfg.tester.role, "scout_retry", { attempt: cycle, error: cycleError });
  }

  if (!testOk) {
    if (testerStarted) emitWorkflowEvent(workflowId, cfg.tester.role, "scout_end", { ok: false, error: cycleError });
    emitWorkflowEvent(workflowId, cfg.developer.role, "scout_end", { ok: false, error: cycleError });
  }

  // Commit and push whatever real work exists, even if tests never passed -
  // never silently throw away a developer's changes because of an exit code.
  const committed = await commitAll(worktreePath, title);
  if (committed) {
    const push = await pushBranch(worktreePath, branch);
    ctx.pushed = push.exitCode === 0;
    if (!ctx.pushed) emitWorkflowEvent(workflowId, "orchestrator", "push_error", { error: push.stderr.trim().slice(-500) });
  }

  const finalDiff = await diffText(worktreePath, cfg.baseBranch);

  // 5. Reviewer - never shares a model with the developer, and its
  // readyForReview verdict is cross-checked against the real build/test
  // results (reviewerGates' verdict_consistent), so it can't rubber-stamp.
  const reviewResult = await runPhase<ReviewerEnvelope>(
    ctx,
    cfg.reviewer,
    "none",
    {
      SPEC_JSON: specJson,
      PLAN_JSON: planJson,
      ARCHITECTURE_JSON: architectureJson,
      DEV_SUMMARY: devEnvelope?.summary ?? "(no developer summary - see gate history)",
      TEST_SUMMARY: testerEnvelope?.summary ?? "(no tester summary - see gate history)",
      DIFF: finalDiff || "(empty diff)",
      BASE_BRANCH: cfg.baseBranch,
      BUILD_OK: String(buildOk),
      TEST_OK: String(testOk),
    },
    roleSystemPrompt("reviewer"),
    (raw) => reviewerGates(raw, specIds, buildOk, testOk),
  );

  const ok = Boolean(reviewResult.ok && reviewResult.envelope?.readyForReview);
  return finish(
    ctx,
    branch,
    ok,
    reviewResult.error,
    specJson,
    planJson,
    architectureJson,
    devEnvelope?.summary,
    reviewResult.envelope ? JSON.stringify(reviewResult.envelope, null, 2) : undefined,
    buildOk,
    testOk,
  );
  }
}

async function finish(
  ctx: RunContext,
  branch: string,
  ok: boolean,
  error: string | undefined,
  specJson: string,
  planJson: string,
  architectureJson: string,
  devSummary: string | undefined,
  reviewJson: string | undefined,
  buildOk: boolean,
  testOk: boolean,
): Promise<BuildFeatureResult> {
  const runDir = join(RUNS_DIR, ctx.workflowId);
  mkdirSync(runDir, { recursive: true });

  // Nothing committed (failed before the developer changed anything): an
  // empty branch + worktree is just clutter in the user's repo, and there's
  // nothing a PR could show. Real commits are always kept, even unpushed.
  if (!ctx.pushed && !(await branchHasCommits(ctx))) {
    await removeWorktree(ctx.repoCwd, ctx.worktreePath);
    await deleteBranch(ctx.repoCwd, branch);
    branch = "";
  }

  const reportLines = [
    `# build-feature: ${ctx.title}`,
    "",
    `Request: ${ctx.topic}`,
    `Branch: ${branch ? `\`${branch}\`` : "(none - removed, nothing was committed)"}`,
    `Build: ${buildOk ? "passed" : "failed"} · Tests: ${testOk ? "passed" : "failed"} · Overall: ${ok ? "ready" : "needs attention"}`,
    "",
    "## Spec",
    "```json",
    specJson,
    "```",
  ];
  if (planJson) reportLines.push("", "## Plan", "```json", planJson, "```");
  if (architectureJson) reportLines.push("", "## Architecture", "```json", architectureJson, "```");
  if (devSummary) reportLines.push("", "## Developer summary", devSummary);
  if (reviewJson) reportLines.push("", "## Review coverage", "```json", reviewJson, "```");
  if (error) reportLines.push("", "## Error", error);

  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, reportLines.join("\n"));

  let prUrl: string | undefined;
  if (!ctx.pushed) {
    emitWorkflowEvent(ctx.workflowId, "orchestrator", "workflow_end", { ok, reportPath, branch, buildOk, testOk, error });
    return { workflowId: ctx.workflowId, ok, error, topic: ctx.topic, title: ctx.title, branch, reportPath };
  }
  try {
    const body = [
      `> ${ctx.topic.split("\n").join("\n> ")}`,
      "",
      `Generated by \`sf workflow build-feature\` (workflow \`${ctx.workflowId}\`).`,
      "",
      `**Status:** ${ok ? "✅ ready for review" : "⚠️ needs attention - see gate failures in the dashboard"}`,
      `**Build:** ${buildOk ? "passed" : "failed"} · **Tests:** ${testOk ? "passed" : "failed"}`,
      "",
      reviewJson ? "## Coverage matrix\n```json\n" + reviewJson + "\n```" : "_No reviewer output - see report.md_",
      "",
      `Full event trace: see \`sf dashboard\` for workflow \`${ctx.workflowId}\`.`,
    ].join("\n");
    const pr = await ensurePr(process.cwd(), branch, ctx.cfg.baseBranch, ctx.title, body);
    prUrl = pr.url;
  } catch (err) {
    emitWorkflowEvent(ctx.workflowId, "orchestrator", "pr_error", { error: err instanceof Error ? err.message : String(err) });
  }

  emitWorkflowEvent(ctx.workflowId, "orchestrator", "workflow_end", { ok, reportPath, branch, prUrl, buildOk, testOk, error });

  return { workflowId: ctx.workflowId, ok, error, topic: ctx.topic, title: ctx.title, branch, prUrl, reportPath };
}

async function branchHasCommits(ctx: RunContext): Promise<boolean> {
  const files = await diffFiles(ctx.worktreePath, ctx.cfg.baseBranch);
  return files.length > 0;
}
