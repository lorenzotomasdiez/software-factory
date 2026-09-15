import { statSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR } from "../home";
import { emitWorkflowEvent } from "./events";

// An agent is only stopped for being STUCK, not for being slow: an agent
// reading a dozen files (or a developer editing them) legitimately runs well
// past any fixed wall-clock budget - a flat 5 min used to kill spec/scout
// agents mid-read, and a flat 15 min killed productive developers mid-edit.
// Activity = any event the agent's pi extension appends to this workflow's event log.
const AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
// Backstop for an agent that stays "active" forever (e.g. looping on a tool).
const AGENT_MAX_RUNTIME_MS = 90 * 60 * 1000;
const ACTIVITY_POLL_MS = 15 * 1000;

/**
 * Kills `proc` once its workflow has gone quiet for too long (or it has run
 * past the hard ceiling). Call the returned function after the process exits:
 * it stops the watchdog and returns why the harness killed it, if it did.
 */
export function watchAgent(proc: { kill(): void }, workflowId: string, role: string): () => string | undefined {
  const startedAt = Date.now();
  const eventsFile = join(EVENTS_DIR, `${workflowId}.jsonl`);
  let timedOut: string | undefined;
  const watchdog = setInterval(() => {
    const now = Date.now();
    let lastActivity = startedAt;
    try {
      lastActivity = Math.max(startedAt, statSync(eventsFile).mtimeMs);
    } catch {
      // no events file yet - count from spawn time
    }
    if (now - lastActivity > AGENT_IDLE_TIMEOUT_MS) {
      timedOut = `no activity for ${Math.round((now - lastActivity) / 60000)} min`;
    } else if (now - startedAt > AGENT_MAX_RUNTIME_MS) {
      timedOut = `exceeded the ${Math.round(AGENT_MAX_RUNTIME_MS / 60000)} min max runtime`;
    }
    if (timedOut) {
      clearInterval(watchdog);
      emitWorkflowEvent(workflowId, role, "agent_timeout", { reason: timedOut });
      proc.kill();
    }
  }, ACTIVITY_POLL_MS);
  return () => {
    clearInterval(watchdog);
    return timedOut;
  };
}
