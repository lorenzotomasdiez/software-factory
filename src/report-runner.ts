import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildReportManifest, REPORTS_DIR, writeReportManifest } from "./report-manifest";

const JOB_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReportJob {
  id: string;
  status: "running" | "done" | "error";
  outputPath?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ReportJob>();

export function getReportJob(id: string): ReportJob | undefined {
  return jobs.get(id);
}

/**
 * The fixed instructions for the headless report agent, appended as a
 * system prompt (same convention as the workflow orchestrators: a static
 * template via --append-system-prompt, a short dynamic prompt as the
 * positional argument). Skills don't auto-trigger under --bare, so the
 * dynamic prompt below explicitly invokes /lavish.
 */
const REPORT_SYSTEM_PROMPT = `You are generating a static HTML report for a completed (or in-progress) software-factory
run, using the "lavish" skill.

## What to read

A manifest JSON file describing this run is at the path given to you in the prompt. It
lists, per role/lane:
- sessionId / cwd: identify that role's pi sub-agent.
- transcriptPath: the JSONL file with that role's REAL conversation - lines of type
  "message" carry the full role/content of every turn, including "thinking" blocks. Read
  this to show what the agent actually said and did, not just tool-call metadata.
- status: "running" | "ended" | "failed".

It may also list reportMdPath: the workflow's own final report/spec markdown file, if one
exists yet.

If a lane's transcriptPath is null, its pi process crashed or never wrote a transcript - say
so plainly in the report. Do not fabricate content for it.

If the manifest's top-level status is "running", prominently note in the report that the run
was still in progress when this report was generated and some lanes may be incomplete.

## What to build

One rich, self-contained HTML report that shows, per role/lane:
- The real conversation that role had, based on its transcript - not a restatement of tool
  call counts.
- What it received as input and what it produced/handed off, inferred by reading its own
  transcript together with the other lanes' transcripts and the workflow's report/spec
  markdown, in whatever order makes the handoff clear. There is no separate structured
  handoff record - reconstruct it yourself from the real artifacts.
- Status (ended/failed/still running).

Follow the lavish skill's visual guidance (hierarchy, structure, no unnecessary prose) for
the layout.

## Hard rules for this run - do not deviate

- Work only inside your current working directory. Do not read or write any path outside
  the manifest, the paths it lists, and your own working directory.
- Do NOT run \`npx -y lavish-axi <html-file>\` to open an interactive review session.
- Do NOT run \`npx -y lavish-axi poll\` under any circumstance - this is a fully automated,
  one-shot report with nobody reviewing it live.
- Write the HTML report directly to \`report.html\` in your working directory.
- Then run exactly one lavish-axi command: \`npx -y lavish-axi export report.html --out <output-path>\`,
  using the exact output path given to you in the prompt.
- That export command is your last action. Do not run \`end\`, \`share\`, or any other
  lavish-axi subcommand, and do not keep iterating on the artifact after it succeeds.`;

function buildDynamicPrompt(manifestPath: string, outputPath: string): string {
  // A prompt starting with "/word" is parsed by claude's own CLI as an
  // attempt to invoke a top-level command ("Usage: claude [options]
  // [command] [prompt]") and fails with "Unknown command: /lavish" -
  // confirmed empirically. Mentioning /lavish mid-sentence instead reliably
  // reaches the model as plain text and still resolves the skill under --bare.
  return [
    `Generate the run report now using the /lavish skill. Manifest: ${manifestPath}`,
    `Final export output path: ${outputPath}`,
  ].join("\n");
}

/** Idempotent: returns the existing job unchanged if one is already running for this id. */
export function startReportJob(id: string, opts: { force?: boolean } = {}): ReportJob {
  const existing = jobs.get(id);
  if (existing && existing.status === "running") return existing;
  if (existing && existing.status === "done" && !opts.force) return existing;

  const job: ReportJob = { id, status: "running", startedAt: Date.now() };
  jobs.set(id, job);

  (async () => {
    try {
      const manifest = buildReportManifest(id);
      const manifestPath = writeReportManifest(manifest);
      const runDir = join(REPORTS_DIR, id);
      const scratchDir = join(runDir, ".lavish");
      const outputPath = join(runDir, "report.html");
      mkdirSync(scratchDir, { recursive: true });

      // Neither --safe-mode (disables skills entirely) nor --bare (per its
      // own --help text, "OAuth and keychain are never read" - forces
      // ANTHROPIC_API_KEY/apiKeyHelper only) can be used here: this feature
      // needs both the lavish skill AND the user's normal OAuth/keychain
      // login to work, so it runs with no isolation flag at all. The fresh
      // scratchDir as cwd (no project CLAUDE.md there) is the only isolation.
      const proc = Bun.spawn({
        cmd: [
          "claude",
          "-p",
          buildDynamicPrompt(manifestPath, outputPath),
          "--append-system-prompt",
          REPORT_SYSTEM_PROMPT,
          "--allowedTools",
          "Read,Write,Bash(npx -y lavish-axi export*)",
        ],
        cwd: scratchDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeout = setTimeout(() => proc.kill(), JOB_TIMEOUT_MS);
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timeout);

      job.finishedAt = Date.now();
      if (existsSync(outputPath)) {
        job.status = "done";
        job.outputPath = outputPath;
      } else {
        job.status = "error";
        // claude -p sometimes reports fatal errors (e.g. not logged in) on
        // stdout rather than stderr, so fall back to stdout when stderr is empty.
        job.error = (stderr.trim() || stdout.trim()).slice(-1000) || "report generation finished without producing an output file";
      }
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    }
  })();

  return job;
}
