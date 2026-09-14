import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAllEvents, summarizeSessions, type SfEvent } from "./dashboard";
import { ROOT_DIR } from "./home";
import { findTranscriptPath } from "./pi-sessions";
import { RUNS_DIR as BUILD_FEATURE_RUNS_DIR } from "./workflows/build-feature/config";
import { RUNS_DIR as SCOUT_CONTEXT_RUNS_DIR } from "./workflows/scout-context/config";
import { RUNS_DIR as SPEC_CONTEXT_RUNS_DIR } from "./workflows/spec-context/config";

export const REPORTS_DIR = join(ROOT_DIR, "reports");

type WorkflowName = "build-feature" | "scout-context" | "spec-context";

const REPORT_FILE_BY_WORKFLOW: Record<WorkflowName, { runsDir: string; fileName: string }> = {
  "build-feature": { runsDir: BUILD_FEATURE_RUNS_DIR, fileName: "report.md" },
  "scout-context": { runsDir: SCOUT_CONTEXT_RUNS_DIR, fileName: "report.md" },
  "spec-context": { runsDir: SPEC_CONTEXT_RUNS_DIR, fileName: "spec.md" },
};

export interface ManifestLane {
  role: string;
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
  status: "running" | "ended" | "failed";
}

export interface ReportManifest {
  id: string;
  kind: "workflow" | "session";
  workflowName?: WorkflowName;
  topic?: string;
  status: "running" | "ended";
  reportMdPath?: string;
  lanes: ManifestLane[];
  generatedAt: string;
}

function isWorkflowName(name: string | undefined): name is WorkflowName {
  return name === "build-feature" || name === "scout-context" || name === "spec-context";
}

/** Builds the read-only index a headless report-generation agent uses to
 *  find every role's real transcript and workflow artifact, without
 *  encoding any handoff structure itself - the agent reads the files and
 *  reasons about what was received/produced by each role. */
export function buildReportManifest(id: string): ReportManifest {
  const events = readAllEvents().filter((e) => e.session_id === id || e.workflow_id === id);
  if (!events.length) throw new Error(`no events found for "${id}"`);

  const summary = summarizeSessions(readAllEvents()).find((s) => s.session_id === id);
  const isWorkflow = events.some((e) => e.workflow_id);
  const start = events.find((e) => e.type === "workflow_start");
  const startData = start?.data as { topic?: string; workflow?: string } | undefined;
  const workflowName = isWorkflowName(startData?.workflow) ? startData?.workflow : undefined;

  const byRole = new Map<string, SfEvent[]>();
  for (const e of events) {
    const role = e.role || (isWorkflow ? "orchestrator" : "agent");
    if (role === "orchestrator" && isWorkflow) continue;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)!.push(e);
  }

  const lanes: ManifestLane[] = [];
  for (const [role, roleEvents] of byRole) {
    // Workflow lanes carry both: our own "session_started" (has sessionId/cwd)
    // and pi's own "session_start" from inside the spawned process (just
    // {reason:"startup"}, no cwd) - fired right after ours, so on a reversed
    // list plain "session_start" would win the OR and drop the lane (no cwd).
    // A plain (non-workflow) `sf pi` session only ever has "session_start",
    // now carrying cwd itself (see home.ts).
    const sessionEvt = [...roleEvents].reverse().find((e) => (isWorkflow ? e.type === "session_started" : e.type === "session_start"));
    if (!sessionEvt) continue;
    const data = sessionEvt.data as { sessionId?: string; cwd?: string } | undefined;
    const sessionId = data?.sessionId ?? sessionEvt.session_id;
    const cwd = data?.cwd;
    if (!cwd) continue;
    const ended = roleEvents.some((e) => e.type === "scout_end" || e.type === "session_end");
    const failed = roleEvents.some((e) => (e.type === "scout_end" || e.type === "session_end") && (e.data as { ok?: boolean } | undefined)?.ok === false);
    lanes.push({
      role,
      sessionId,
      cwd,
      transcriptPath: findTranscriptPath(cwd, sessionId),
      status: failed ? "failed" : ended ? "ended" : "running",
    });
  }

  let reportMdPath: string | undefined;
  if (workflowName) {
    const { runsDir, fileName } = REPORT_FILE_BY_WORKFLOW[workflowName];
    const candidate = join(runsDir, id, fileName);
    if (existsSync(candidate)) reportMdPath = candidate;
  }

  return {
    id,
    kind: isWorkflow ? "workflow" : "session",
    workflowName,
    topic: startData?.topic,
    status: summary?.status ?? "ended",
    reportMdPath,
    lanes,
    generatedAt: new Date().toISOString(),
  };
}

export function writeReportManifest(manifest: ReportManifest): string {
  const dir = join(REPORTS_DIR, manifest.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}
