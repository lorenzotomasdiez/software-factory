import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR } from "../home";

/**
 * Writes into the same per-session JSONL event stream the dashboard reads
 * (see src/dashboard.ts), so a workflow run and its scout sub-agents show up
 * together as one grouped trace instead of a separate observability path.
 */
export function emitWorkflowEvent(
  workflowId: string,
  role: string,
  type: string,
  data?: unknown,
): void {
  try {
    mkdirSync(EVENTS_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: workflowId,
      agent: "workflow",
      workflow_id: workflowId,
      role,
      type,
      data,
    });
    appendFileSync(join(EVENTS_DIR, `${workflowId}.jsonl`), `${line}\n`);
  } catch {
    // observability must never break a workflow run
  }
}
