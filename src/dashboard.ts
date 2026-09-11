import { existsSync, mkdirSync, readFileSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR } from "./home";

export const DEFAULT_DASHBOARD_PORT = 4317;

interface SfEvent {
  ts: string;
  session_id: string;
  agent: string;
  profile?: string;
  provider?: string;
  model?: string;
  workflow_id?: string;
  role?: string;
  type: string;
  data?: unknown;
}

function readAllEvents(): SfEvent[] {
  if (!existsSync(EVENTS_DIR)) return [];
  const files = readdirSync(EVENTS_DIR).filter((f) => f.endsWith(".jsonl"));
  const events: SfEvent[] = [];
  for (const file of files) {
    const content = readFileSync(join(EVENTS_DIR, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

interface Lane {
  role: string;
  status: "running" | "ended";
  tool_count: number;
}

interface SessionSummary {
  session_id: string; // workflow_id when this row is a workflow, else the plain session id
  kind: "session" | "workflow";
  agent: string;
  profile?: string;
  provider?: string;
  model?: string;
  topic?: string;
  started_at: string;
  last_event_at: string;
  status: "running" | "ended";
  event_count: number;
  tool_count: number;
  lanes?: Lane[];
}

/** Groups by workflow_id when present (orchestrator + all its scout lanes together), else by session_id. */
function summarizeSessions(events: SfEvent[]): SessionSummary[] {
  const groups = new Map<string, SfEvent[]>();
  for (const e of events) {
    const key = e.workflow_id || e.session_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const summaries: SessionSummary[] = [];
  for (const [key, evts] of groups) {
    const first = evts[0];
    const last = evts[evts.length - 1];
    const isWorkflow = Boolean(first.workflow_id);
    let lanes: Lane[] | undefined;
    let topic: string | undefined;
    let status: "running" | "ended" = evts.some((e) => e.type === "session_end" || e.type === "workflow_end")
      ? "ended"
      : "running";
    if (isWorkflow) {
      const byRole = new Map<string, SfEvent[]>();
      for (const e of evts) {
        const role = e.role || "orchestrator";
        if (!byRole.has(role)) byRole.set(role, []);
        byRole.get(role)!.push(e);
      }
      lanes = [...byRole.entries()]
        .filter(([role]) => role !== "orchestrator")
        .map(([role, roleEvts]) => ({
          role,
          status: roleEvts.some((e) => e.type === "scout_end") ? "ended" : "running",
          tool_count: roleEvts.filter((e) => e.type === "tool_call").length,
        }));
      const start = evts.find((e) => e.type === "workflow_start");
      topic = (start?.data as { topic?: string } | undefined)?.topic;
    }
    summaries.push({
      session_id: key,
      kind: isWorkflow ? "workflow" : "session",
      agent: isWorkflow ? "workflow" : first.agent,
      profile: first.profile,
      provider: first.provider,
      model: first.model,
      topic,
      started_at: first.ts,
      last_event_at: last.ts,
      status,
      event_count: evts.length,
      tool_count: evts.filter((e) => e.type === "tool_call").length,
      lanes,
    });
  }
  summaries.sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  return summaries;
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>software-factory dashboard</title>
<style>
  :root {
    --bg: #0b0b0d; --panel: #131316; --border: #26262b; --text: #e6e6e6;
    --dim: #8a8a92; --accent: #9d7bff; --green: #4caf50; --blue: #2196f3;
    --orange: #ff9800; --red: #e5484d;
  }
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: var(--bg); color: var(--text);
         margin: 0; height: 100vh; display: flex; flex-direction: column; font-size: 13px; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 14px; color: var(--accent); margin: 0; font-weight: 600; }
  header .live { color: var(--green); font-size: 11px; }
  header .live.stale { color: var(--red); }
  main { flex: 1; display: flex; min-height: 0; }
  #sessions { width: 320px; border-right: 1px solid var(--border); overflow-y: auto; flex-shrink: 0; }
  .session-item { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .session-item:hover { background: var(--panel); }
  .session-item.active { background: var(--panel); border-left: 3px solid var(--accent); }
  .session-item .row1 { display: flex; justify-content: space-between; align-items: center; }
  .session-item .agent { font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  .session-item .agent.pi { color: var(--blue); }
  .session-item .agent.claude { color: var(--orange); }
  .session-item .agent.workflow { color: var(--accent); }
  .session-item .topic { color: var(--text); font-size: 12px; margin-top: 3px; font-weight: 600; }
  .lanes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .lane-badge { font-size: 9px; padding: 1px 5px; border-radius: 6px; border: 1px solid var(--border); color: var(--dim); }
  .lane-badge.ended { color: var(--green); border-color: var(--green); }
  .role-tag { font-size: 10px; padding: 0 5px; border-radius: 6px; background: #1e1e24; color: var(--accent); }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border); color: var(--dim); }
  .badge.running { color: var(--green); border-color: var(--green); }
  .session-item .meta { color: var(--dim); font-size: 11px; margin-top: 3px; }
  .session-item .idshort { color: var(--dim); font-size: 10px; margin-top: 2px; }
  #timeline { flex: 1; overflow-y: auto; padding: 14px 18px; }
  #timeline .empty { color: var(--dim); padding: 40px; text-align: center; }
  .event { border-left: 3px solid #333; padding: 6px 10px; margin-bottom: 6px; border-radius: 0 4px 4px 0; background: var(--panel); }
  .event.session_start, .event.session_end { border-color: var(--green); }
  .event.tool_call { border-color: var(--blue); }
  .event.tool_result.error { border-color: var(--red); }
  .event.tool_result { border-color: var(--orange); }
  .event.turn_end { border-color: #555; opacity: 0.7; }
  .event .line1 { display: flex; gap: 8px; align-items: baseline; }
  .ts { color: var(--dim); font-size: 11px; }
  .type { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  .toolname { color: var(--accent); font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-all; margin: 4px 0 0; color: var(--dim); font-size: 11.5px; }
</style>
</head>
<body>
<header>
  <h1>&#127981; software-factory observability</h1>
  <span class="live" id="live">&#9679; live</span>
</header>
<main>
  <div id="sessions"></div>
  <div id="timeline"><div class="empty">Select a session</div></div>
</main>
<script>
  let selected = null;
  let sessions = [];

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h ago";
  }

  function renderSessions() {
    const el = document.getElementById("sessions");
    if (sessions.length === 0) {
      el.innerHTML = '<div class="empty" style="padding:20px;color:var(--dim)">No sessions yet.<br>Launch with <code>sf claude</code> or <code>sf pi</code>.</div>';
      return;
    }
    el.innerHTML = sessions.map(s => \`
      <div class="session-item \${s.session_id === selected ? "active" : ""}" data-id="\${s.session_id}">
        <div class="row1">
          <span class="agent \${s.agent}">\${s.kind === "workflow" ? "&#127981; scout-context" : s.agent}</span>
          <span class="badge \${s.status}">\${s.status}</span>
        </div>
        \${s.topic ? \`<div class="topic">\${s.topic}</div>\` : ""}
        <div class="meta">\${s.profile || "default"}\${s.model ? " &middot; " + s.model : ""}</div>
        <div class="meta">\${s.tool_count} tool calls &middot; \${timeAgo(s.last_event_at)}</div>
        \${s.lanes ? \`<div class="lanes">\${s.lanes.map(l => \`<span class="lane-badge \${l.status}">\${l.role.replace("scout-", "")} &middot; \${l.tool_count}</span>\`).join("")}</div>\` : ""}
        <div class="idshort">\${s.session_id.slice(0, 12)}</div>
      </div>\`).join("");
    el.querySelectorAll(".session-item").forEach(item => {
      item.addEventListener("click", () => { selected = item.dataset.id; renderSessions(); loadTimeline(); });
    });
  }

  function renderTimeline(events) {
    const el = document.getElementById("timeline");
    if (events.length === 0) { el.innerHTML = '<div class="empty">No events yet</div>'; return; }
    el.innerHTML = events.map(e => {
      const cls = e.type + (e.data && e.data.isError ? " error" : "");
      const label = e.data && e.data.toolName ? \`<span class="toolname">\${e.data.toolName}</span>\` : "";
      const role = e.role ? \`<span class="role-tag">\${e.role}</span>\` : "";
      return \`<div class="event \${cls}">
        <div class="line1">
          <span class="ts">\${new Date(e.ts).toLocaleTimeString()}</span>
          \${role}
          <span class="type">\${e.type}</span>
          \${label}
        </div>
        \${e.data ? \`<pre>\${JSON.stringify(e.data)}</pre>\` : ""}
      </div>\`;
    }).join("");
    el.scrollTop = el.scrollHeight;
  }

  async function loadSessions() {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    if (!selected && sessions.length > 0) selected = sessions[0].session_id;
    renderSessions();
  }

  async function loadTimeline() {
    if (!selected) return;
    const res = await fetch("/api/events?session=" + encodeURIComponent(selected));
    renderTimeline(await res.json());
  }

  async function refresh() {
    await loadSessions();
    await loadTimeline();
  }

  refresh();
  const stream = new EventSource("/api/stream");
  const live = document.getElementById("live");
  stream.onmessage = refresh;
  stream.onerror = () => { live.textContent = "\\u25cf disconnected"; live.classList.add("stale"); };
  stream.onopen = () => { live.textContent = "\\u25cf live"; live.classList.remove("stale"); };
</script>
</body>
</html>`;

export function startDashboard(port: number): void {
  mkdirSync(EVENTS_DIR, { recursive: true });

  const clients = new Set<(data: string) => void>();
  watch(EVENTS_DIR, () => {
    for (const send of clients) send("data: update\n\n");
  });

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") {
        return new Response("ok");
      }
      if (url.pathname === "/api/events") {
        const session = url.searchParams.get("session");
        const events = readAllEvents();
        return Response.json(
          session ? events.filter((e) => e.session_id === session || e.workflow_id === session) : events,
        );
      }
      if (url.pathname === "/api/sessions") {
        return Response.json(summarizeSessions(readAllEvents()));
      }
      if (url.pathname === "/api/stream") {
        let send!: (data: string) => void;
        const stream = new ReadableStream({
          start(controller) {
            send = (data: string) => controller.enqueue(new TextEncoder().encode(data));
            clients.add(send);
            send(": connected\n\n");
          },
          cancel() {
            clients.delete(send);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }
      return new Response(PAGE, { headers: { "Content-Type": "text/html" } });
    },
  });
}

async function isDashboardAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(300) });
    return res.ok;
  } catch {
    return false;
  }
}

/** True in a compiled `bun build --compile` binary, false under `bun run src/cli.ts`. */
function isCompiled(): boolean {
  return !Bun.main.endsWith(".ts");
}

function selfCommand(...args: string[]): string[] {
  return isCompiled() ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args];
}

/**
 * Ensures a dashboard server is running on `port`, starting one as a detached
 * background process (re-invoking this same sf binary) if none responds yet.
 * Safe to call on every `sf claude`/`sf pi` launch - reuses an already-running instance.
 */
export async function ensureDashboardRunning(port = DEFAULT_DASHBOARD_PORT): Promise<string> {
  const url = `http://localhost:${port}`;
  if (await isDashboardAlive(port)) return url;

  Bun.spawn({
    cmd: selfCommand("dashboard", "--internal-serve", "--port", String(port)),
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  }).unref();

  for (let i = 0; i < 30; i++) {
    if (await isDashboardAlive(port)) return url;
    await Bun.sleep(100);
  }
  return url;
}
