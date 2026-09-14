import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR } from "../home";
import { emitWorkflowEvent } from "./events";

const CANCEL_DIR = join(EVENTS_DIR, "cancel");

interface CancelState {
  orchestratorPid: number;
  activeChildPids: number[];
}

function stateFile(workflowId: string): string {
  return join(CANCEL_DIR, `${workflowId}.json`);
}

function flagFile(workflowId: string): string {
  return join(CANCEL_DIR, `${workflowId}.cancel`);
}

function readState(workflowId: string): CancelState | null {
  try {
    return JSON.parse(readFileSync(stateFile(workflowId), "utf-8")) as CancelState;
  } catch {
    return null;
  }
}

function writeState(workflowId: string, state: CancelState): void {
  try {
    mkdirSync(CANCEL_DIR, { recursive: true });
    writeFileSync(stateFile(workflowId), JSON.stringify(state));
  } catch {
    // cancellation bookkeeping must never break a workflow run
  }
}

const signalHandlers = new Map<string, () => void>();

/** Call once, from the orchestrator process, right when a workflow starts. */
export function registerWorkflow(workflowId: string): void {
  writeState(workflowId, { orchestratorPid: process.pid, activeChildPids: [] });
  // requestCancel SIGTERMs this process directly (the only way to stop it
  // mid-agent-turn). Without a handler the default action kills it silently:
  // no workflow_end in the trace, and the caller (the pi /build-feature etc.
  // command) sees an empty-output crash instead of exit 130 + the
  // CANCELLED_BY_USER marker it uses to tell the main agent the user stopped it.
  const onTerm = () => {
    const cancelled = isCancelled(workflowId);
    emitWorkflowEvent(workflowId, "orchestrator", "workflow_end", cancelled ? { ok: false, cancelled: true } : { ok: false, error: "orchestrator terminated (SIGTERM)" });
    clearWorkflow(workflowId);
    if (cancelled) {
      console.log("sf: workflow CANCELLED_BY_USER");
      process.exit(130);
    }
    console.error("sf: workflow terminated (SIGTERM)");
    process.exit(143);
  };
  signalHandlers.set(workflowId, onTerm);
  process.once("SIGTERM", onTerm);
}

/** Call right after spawning a `pi` child (there can be several at once, e.g. parallel scouts). */
export function trackChild(workflowId: string, pid: number): void {
  const state = readState(workflowId) ?? { orchestratorPid: process.pid, activeChildPids: [] };
  if (!state.activeChildPids.includes(pid)) state.activeChildPids.push(pid);
  writeState(workflowId, state);
}

export function untrackChild(workflowId: string, pid: number): void {
  const state = readState(workflowId);
  if (!state) return;
  writeState(workflowId, { ...state, activeChildPids: state.activeChildPids.filter((p) => p !== pid) });
}

/**
 * Whether the orchestrator for this workflow is still an actual live process.
 * The state file exists from registerWorkflow until clearWorkflow, and the pid
 * check covers an orchestrator that died without cleaning up (crash, kill -9).
 */
export function isWorkflowAlive(workflowId: string): boolean {
  const state = readState(workflowId);
  if (!state) return false;
  try {
    process.kill(state.orchestratorPid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Checked by the orchestrator between phases/attempts - cooperative cancellation. */
export function isCancelled(workflowId: string): boolean {
  return existsSync(flagFile(workflowId));
}

export function clearWorkflow(workflowId: string): void {
  const handler = signalHandlers.get(workflowId);
  if (handler) {
    process.off("SIGTERM", handler);
    signalHandlers.delete(workflowId);
  }
  try {
    rmSync(stateFile(workflowId), { force: true });
  } catch {
    // best-effort cleanup
  }
  try {
    rmSync(flagFile(workflowId), { force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Called from the dashboard server - a DIFFERENT OS process from the
 * orchestrator - to cancel a running workflow. Sets the cooperative flag
 * (checked between phases/attempts) AND sends SIGTERM directly to every
 * currently-running child `pi` process plus the orchestrator itself, so
 * cancellation is immediate rather than waiting for the current agent turn
 * to finish on its own (which can take minutes).
 */
export function requestCancel(workflowId: string): { found: boolean; killedPids: number[] } {
  mkdirSync(CANCEL_DIR, { recursive: true });
  writeFileSync(flagFile(workflowId), String(Date.now()));
  const state = readState(workflowId);
  if (!state) return { found: false, killedPids: [] };

  const killed: number[] = [];
  for (const pid of state.activeChildPids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // process may have already exited
    }
  }
  try {
    process.kill(state.orchestratorPid, "SIGTERM");
    killed.push(state.orchestratorPid);
  } catch {
    // process may have already exited
  }
  return { found: true, killedPids: killed };
}

export class WorkflowCancelledError extends Error {
  constructor(workflowId: string) {
    super(`cancelled by the user (workflow ${workflowId})`);
    this.name = "WorkflowCancelledError";
  }
}

export function throwIfCancelled(workflowId: string): void {
  if (isCancelled(workflowId)) throw new WorkflowCancelledError(workflowId);
}
