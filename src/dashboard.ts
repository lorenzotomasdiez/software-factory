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
  workflow_name?: string;
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
    let workflowName: string | undefined;
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
      const startData = start?.data as { topic?: string; workflow?: string } | undefined;
      topic = startData?.topic;
      workflowName = startData?.workflow;
    }
    summaries.push({
      session_id: key,
      kind: isWorkflow ? "workflow" : "session",
      agent: isWorkflow ? "workflow" : first.agent,
      workflow_name: workflowName,
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
    --bg: #0b0b0d; --panel: #131316; --panel2: #18181c; --border: #26262b; --border-soft: #1d1d21; --text: #e6e6e6;
    --dim: #8a8a92; --faint: #5a5a62; --accent: #9d7bff; --green: #4caf50; --blue: #2196f3;
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
  #sessions { width: 300px; border-right: 1px solid var(--border); overflow-y: auto; flex-shrink: 0; }
  #detail { flex: 1; overflow-y: auto; }
  #detail .empty, #sessions .empty { color: var(--dim); padding: 40px 20px; text-align: center; }

  /* ── session list cards ─────────────────────────────────────────────── */
  .card { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .card:hover { background: var(--panel); }
  .card.active { background: var(--panel); border-left: 3px solid var(--accent); }
  .card .row1 { display: flex; justify-content: space-between; align-items: center; }
  .card .agent { font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  .card .agent.pi { color: var(--blue); }
  .card .agent.claude { color: var(--orange); }
  .card .agent.workflow { color: var(--accent); }
  .card .topic { color: var(--text); font-size: 12px; margin-top: 3px; font-weight: 600; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border); color: var(--dim); }
  .badge.running { color: var(--blue); border-color: var(--blue); }
  .badge.ended { color: var(--green); border-color: var(--green); }
  .badge.failed { color: var(--red); border-color: var(--red); }
  .card .meta { color: var(--dim); font-size: 11px; margin-top: 3px; }
  .card .idshort { color: var(--faint); font-size: 10px; margin-top: 2px; }
  .mini-tl { position: relative; height: 6px; margin-top: 6px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
  .mini-dot { position: absolute; top: 0; bottom: 0; width: 2px; }
  .mini-rows { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }

  /* ── waterfall (detail view) ────────────────────────────────────────── */
  .run-strip { display: flex; align-items: center; gap: 14px; padding: 12px 18px; border-bottom: 1px solid var(--border-soft); flex-wrap: wrap; }
  .run-strip .topic { font-size: 14px; font-weight: 600; }
  .waterfall { margin: 16px 18px; border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; }
  .wf-row { display: grid; grid-template-columns: 200px 1fr; border-bottom: 1px solid var(--border-soft); }
  .wf-row:last-child { border-bottom: none; }
  .wf-row.axis { background: var(--panel2); border-bottom: 1px solid var(--border); }
  .wf-label { padding: 8px 12px; display: flex; flex-direction: column; justify-content: center; gap: 4px; border-right: 1px solid var(--border); overflow: hidden; }
  .wf-label .name { font-weight: 700; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wf-label .model { font-size: 10px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx-bar { height: 4px; border-radius: 2px; background: var(--panel2); overflow: hidden; margin-top: 2px; }
  .ctx-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--blue)); }
  .wf-track { position: relative; height: 52px; }
  .axis .wf-track { height: 26px; }
  .axis-tick { position: absolute; bottom: 4px; transform: translateX(-50%); font-size: 10px; color: var(--faint); white-space: nowrap; }
  .axis-tick.edge { transform: none; }
  .gridline { position: absolute; top: 0; bottom: 0; border-left: 1px dashed rgba(174,191,212,0.10); }
  .block { position: absolute; top: 8px; height: 36px; border-radius: 6px; border: 1px solid; padding: 4px 8px; overflow: hidden;
           white-space: nowrap; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 11px; transition: box-shadow .15s ease; }
  .block:hover { box-shadow: 0 0 12px rgba(157,123,255,0.25); }
  .block.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
  .block.running { animation: pulse 1.6s ease-in-out infinite; }
  .glyph { flex: none; font-size: 11px; }
  .glyph.ended { color: var(--green); }
  .glyph.failed { color: var(--red); }
  .glyph.running { color: var(--blue); }
  .b-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
  .b-dur { margin-left: auto; color: var(--dim); font-size: 10px; flex: none; }
  .b-gate { flex: none; font-size: 10px; padding: 0 4px; border-radius: 3px; border: 1px solid; }
  .b-gate.pass { color: var(--green); border-color: var(--green); }
  .b-gate.fail { color: var(--red); border-color: var(--red); }
  .tool-tick { position: absolute; bottom: 3px; width: 2px; height: 7px; background: currentColor; opacity: 0.6; border-radius: 1px; }
  .tool-tick.err { background: var(--red); opacity: 1; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

  /* ── lane drill-down panel ──────────────────────────────────────────── */
  #lane-detail { margin: 0 18px 24px; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--panel); }
  #lane-detail .ld-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border-soft); }
  #lane-detail .ld-head .name { font-weight: 700; font-size: 13px; }
  #lane-detail .ld-head .close { cursor: pointer; color: var(--dim); font-size: 16px; background: none; border: none; }
  #lane-detail .ld-head .close:hover { color: var(--text); }
  #lane-detail .ld-body { max-height: 420px; overflow-y: auto; padding: 8px 14px; }
  .ld-event { border-left: 3px solid #333; padding: 5px 10px; margin-bottom: 5px; border-radius: 0 4px 4px 0; background: var(--panel2); font-size: 11.5px; }
  .ld-event.tool_call { border-color: var(--blue); }
  .ld-event.tool_result { border-color: var(--orange); }
  .ld-event.tool_result.err { border-color: var(--red); }
  .ld-event.scout_end, .ld-event.session_end { border-color: var(--green); }
  .ld-event.scout_end.failed { border-color: var(--red); }
  .ld-event .ld-line1 { display: flex; gap: 8px; align-items: baseline; }
  .ld-ts { color: var(--dim); font-size: 10px; }
  .ld-type { font-weight: 700; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.3px; }
  .ld-tool { color: var(--accent); font-weight: 600; }
  .ld-detail-pre { white-space: pre-wrap; word-break: break-all; margin: 4px 0 0; color: var(--dim); font-size: 11px; }
  .ld-section-h { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin: 10px 0 6px; display: flex; align-items: center; gap: 6px; }
  .ld-section-h:first-child { margin-top: 0; }
  .gate-block { border: 1px solid var(--border-soft); border-left: 3px solid; border-radius: 0 6px 6px 0; margin-bottom: 8px; background: var(--panel2); overflow: hidden; }
  .gate-block.pass { border-left-color: var(--green); }
  .gate-block.fail { border-left-color: var(--red); }
  .gate-block-head { padding: 6px 10px; display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; }
  .gate-block-head .gm { font-weight: 700; }
  .gate-block-head .gm.pass { color: var(--green); }
  .gate-block-head .gm.fail { color: var(--red); }
  .gate-block-head .gsummary { color: var(--dim); margin-left: auto; font-size: 10.5px; }
  .gate-check-row { display: flex; gap: 8px; padding: 3px 10px 3px 22px; font-size: 11px; align-items: baseline; }
  .gate-check-row .cm { flex: none; }
  .gate-check-row.pass .cm { color: var(--green); }
  .gate-check-row.fail .cm { color: var(--red); }
  .gate-check-row .cname { font-weight: 600; flex: none; }
  .gate-check-row .cdetail { color: var(--dim); overflow-wrap: anywhere; }
</style>
</head>
<body>
<header>
  <h1>&#127981; software-factory observability</h1>
  <span class="live" id="live">&#9679; live</span>
</header>
<main>
  <div id="sessions"></div>
  <div id="detail"><div class="empty">Select a session</div></div>
</main>
<script>
  const PALETTE = ["#9d7bff", "#2196f3", "#4caf50", "#ff9800", "#e5484d", "#00bcd4", "#ffc107"];
  let selectedId = null;
  let selectedLane = null;
  let sessions = [];
  const eventsCache = new Map();

  function hashColor(role) {
    let h = 0;
    for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h ago";
  }

  function fmtOffset(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return "+" + s + "s";
    const m = Math.floor(s / 60), rs = s % 60;
    return "+" + m + "m" + (rs ? rs + "s" : "");
  }

  function fmtDur(ms) {
    if (!Number.isFinite(ms)) return "";
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    return Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";
  }

  function fmtCost(usd) {
    if (!usd || usd <= 0) return "$0";
    if (usd < 0.01) return "<$0.01";
    return "$" + usd.toFixed(2);
  }

  function axisTicks(spanMs, count) {
    const ticks = [];
    for (let i = 0; i <= count; i++) ticks.push({ pct: (i / count) * 100, label: fmtOffset((spanMs * i) / count) });
    return ticks;
  }

  /** Groups a session/workflow's raw events into one lane per agent role, with
   *  real start/end timestamps so the waterfall can position blocks by actual
   *  elapsed time instead of arrival order. */
  function computeLanes(events, fallbackAgent) {
    const byRole = new Map();
    for (const e of events) {
      const role = e.role && e.role !== "orchestrator" ? e.role : (e.workflow_id ? null : (fallbackAgent || "agent"));
      if (!role) continue;
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(e);
    }
    const lanes = [];
    for (const [role, evts] of byRole) {
      evts.sort((a, b) => new Date(a.ts) - new Date(b.ts));
      const start = new Date(evts[0].ts).getTime();
      const endEvt = evts.find(e => e.type === "session_end" || e.type === "scout_end");
      const failed = Boolean(endEvt && endEvt.data && endEvt.data.ok === false);
      const running = !endEvt;
      const end = endEvt ? new Date(endEvt.ts).getTime() : Date.now();
      const toolCalls = evts.filter(e => e.type === "tool_call").map(e => ({ ts: new Date(e.ts).getTime(), name: e.data && e.data.toolName }));
      const toolResults = evts.filter(e => e.type === "tool_result");
      const errorCount = toolResults.filter(e => e.data && e.data.isError).length;
      const meta = evts.find(e => e.provider || e.model) || {};
      const angle = evts.find(e => e.data && e.data.angle);
      const ctxEvt = [...evts].reverse().find(e => e.type === "turn_end" && e.data && e.data.contextPercent != null);
      const lastGate = [...evts].reverse().find(e => e.type === "gate_result" && e.data && e.data.checks);
      const gateBadge = lastGate ? {
        passed: lastGate.data.checks.filter(c => c.ok).length,
        total: lastGate.data.checks.length,
        allPass: lastGate.data.checks.every(c => c.ok),
      } : null;
      // sessionCostUsd on a turn_end is already the running total for that
      // pi process (pi's own per-turn cost.total from its model pricing
      // tables, accumulated in the extension) - the last one is the lane's spend.
      const lastTurn = [...evts].reverse().find(e => e.type === "turn_end" && e.data && e.data.sessionCostUsd != null);
      const costUsd = lastTurn ? lastTurn.data.sessionCostUsd : 0;
      lanes.push({
        role, evts, start, end, running,
        status: failed ? "failed" : running ? "running" : "ended",
        provider: meta.provider, model: meta.model,
        title: (angle && angle.data.angle) || role,
        toolCalls, toolCount: toolCalls.length, errorCount, gateBadge, costUsd,
        contextPercent: ctxEvt ? ctxEvt.data.contextPercent : null,
      });
    }
    return lanes.sort((a, b) => a.start - b.start);
  }

  function renderMiniTimeline(lanes, overallStart, overallSpan) {
    if (!lanes.length) return "";
    const rows = lanes.slice(0, 4).map(lane => {
      const dots = lane.evts.map(e => {
        const t = new Date(e.ts).getTime();
        const pct = Math.min(Math.max(((t - overallStart) / overallSpan) * 100, 0), 100);
        const color = e.type === "tool_result" && e.data && e.data.isError ? "var(--red)"
          : e.type.includes("end") ? "var(--green)"
          : e.type === "tool_call" ? "var(--blue)" : "var(--dim)";
        return \`<span class="mini-dot" style="left:\${pct}%;background:\${color}"></span>\`;
      }).join("");
      return \`<div class="mini-tl">\${dots}</div>\`;
    }).join("");
    return \`<div class="mini-rows">\${rows}</div>\`;
  }

  function renderSessions() {
    const el = document.getElementById("sessions");
    if (sessions.length === 0) {
      el.innerHTML = '<div class="empty">No sessions yet.<br>Launch with <code>sf claude</code> or <code>sf pi</code>.</div>';
      return;
    }
    el.innerHTML = sessions.map(s => {
      const events = eventsCache.get(s.session_id);
      let mini = "";
      let cost = 0;
      if (events && events.length) {
        const lanes = computeLanes(events, s.agent);
        const t0 = Math.min(...lanes.map(l => l.start));
        const t1 = Math.max(...lanes.map(l => l.end));
        mini = renderMiniTimeline(lanes, t0, Math.max(t1 - t0, 1000));
        cost = lanes.reduce((sum, l) => sum + (l.costUsd || 0), 0);
      }
      return \`
      <div class="card \${s.session_id === selectedId ? "active" : ""}" data-id="\${s.session_id}">
        <div class="row1">
          <span class="agent \${s.agent}">\${s.kind === "workflow" ? "&#127981; " + (s.workflow_name || "workflow") : s.agent}</span>
          <span class="badge \${s.status}">\${s.status}</span>
        </div>
        \${s.topic ? \`<div class="topic">\${s.topic}</div>\` : ""}
        <div class="meta">\${s.profile || "default"}\${s.model ? " &middot; " + s.model : ""}</div>
        <div class="meta">\${s.tool_count} tool calls &middot; \${fmtCost(cost)} &middot; \${timeAgo(s.last_event_at)}</div>
        \${mini}
        <div class="idshort">\${s.session_id.slice(0, 12)}</div>
      </div>\`;
    }).join("");
    el.querySelectorAll(".card").forEach(item => {
      item.addEventListener("click", () => {
        selectedId = item.dataset.id;
        selectedLane = null;
        renderSessions();
        renderDetail();
      });
    });
  }

  function renderDetail() {
    const el = document.getElementById("detail");
    // Every refresh (file-watch SSE fires on every appended event - constant
    // while a workflow is mid-run - plus the 1s live tick) fully rebuilds this
    // panel's innerHTML, which silently resets scroll to 0. Capture both
    // scrollable regions' positions here and restore them after the rebuild
    // below, or a click into a lane's history could never actually be read.
    const prevDetailScroll = el.scrollTop;
    const prevLdBody = el.querySelector(".ld-body");
    const prevLdScroll = prevLdBody ? prevLdBody.scrollTop : null;
    if (!selectedId) { el.innerHTML = '<div class="empty">Select a session</div>'; return; }
    const session = sessions.find(s => s.session_id === selectedId);
    const events = eventsCache.get(selectedId) || [];
    if (!session) { el.innerHTML = '<div class="empty">Session not found</div>'; return; }
    if (!events.length) { el.innerHTML = '<div class="empty">No events yet</div>'; return; }

    const lanes = computeLanes(events, session.agent);
    if (!lanes.length) { el.innerHTML = '<div class="empty">No agent activity yet</div>'; return; }

    const t0 = Math.min(...lanes.map(l => l.start));
    const t1 = Math.max(...lanes.map(l => l.end));
    const span = Math.max(t1 - t0, 1000);
    const ticks = axisTicks(span, 6);
    const GLYPH = { ended: "&#10003;", failed: "&#10007;", running: "&#9679;" };

    const axisRow = \`<div class="wf-row axis"><div class="wf-label"></div><div class="wf-track">\${ticks.map((t, i) =>
      \`<span class="axis-tick \${i === 0 ? "edge" : ""}" style="left:\${t.pct}%">\${t.label}</span>\`).join("")}</div></div>\`;

    const laneRows = lanes.map(lane => {
      const left = ((lane.start - t0) / span) * 100;
      const width = Math.max(((lane.end - lane.start) / span) * 100, 3);
      const color = hashColor(lane.role);
      const dur = fmtDur(lane.end - lane.start);
      const toolTicks = lane.toolCalls.map(tc => {
        const x = Math.min(Math.max(((tc.ts - lane.start) / Math.max(lane.end - lane.start, 1)) * 100, 1), 99);
        return \`<span class="tool-tick" style="left:\${x}%;color:\${color}"></span>\`;
      }).join("");
      const ctxBar = lane.contextPercent != null
        ? \`<div class="ctx-bar" title="context: \${Math.round(lane.contextPercent)}%"><div class="ctx-fill" style="width:\${Math.max(lane.contextPercent, 2)}%"></div></div>\`
        : "";
      return \`
      <div class="wf-row">
        <div class="wf-label">
          <span class="name" style="color:\${color}" title="\${lane.title}">\${lane.role}</span>
          \${lane.model ? \`<span class="model">\${lane.provider ? lane.provider + "/" : ""}\${lane.model}</span>\` : ""}
          <span class="model" title="spend so far this lane">\${fmtCost(lane.costUsd)}</span>
          \${ctxBar}
        </div>
        <div class="wf-track">
          \${ticks.map(t => \`<span class="gridline" style="left:\${t.pct}%"></span>\`).join("")}
          <div class="block \${lane.status} \${lane.role === selectedLane ? "selected" : ""}" data-role="\${lane.role}"
               style="left:\${left}%;width:\${width}%;border-color:\${color};background:linear-gradient(180deg, \${color}33, \${color}11)"
               title="\${lane.role} - \${lane.status}\${dur ? " - " + dur : ""}">
            <span class="glyph \${lane.status}">\${GLYPH[lane.status]}</span>
            <span class="b-name">\${lane.role}</span>
            \${lane.gateBadge ? \`<span class="b-gate \${lane.gateBadge.allPass ? "pass" : "fail"}" title="deterministic gates: \${lane.gateBadge.passed}/\${lane.gateBadge.total} checks passed">&#128737; \${lane.gateBadge.passed}/\${lane.gateBadge.total}</span>\` : ""}
            <span class="b-dur">\${dur}\${lane.errorCount ? " &middot; " + lane.errorCount + " err" : ""}</span>
            \${toolTicks}
          </div>
        </div>
      </div>\`;
    }).join("");

    const laneDetailHtml = selectedLane ? renderLaneDetail(lanes.find(l => l.role === selectedLane)) : "";

    const totalCost = lanes.reduce((sum, l) => sum + (l.costUsd || 0), 0);
    el.innerHTML = \`
      <div class="run-strip">
        <span class="topic">\${session.topic || session.profile || session.agent}</span>
        <span class="badge \${session.status}">\${session.status}</span>
        <span class="meta">\${session.tool_count} tool calls total</span>
        <span class="meta" title="sum of every lane's real per-turn cost, from pi's own model pricing">&#128176; \${fmtCost(totalCost)} total</span>
      </div>
      <div class="waterfall">\${axisRow}\${laneRows}</div>
      \${laneDetailHtml}
    \`;

    el.scrollTop = prevDetailScroll;
    const newLdBody = el.querySelector(".ld-body");
    if (newLdBody && prevLdScroll != null) newLdBody.scrollTop = prevLdScroll;

    el.querySelectorAll(".block").forEach(b => {
      b.addEventListener("click", () => {
        selectedLane = selectedLane === b.dataset.role ? null : b.dataset.role;
        renderDetail();
      });
    });
    const closeBtn = el.querySelector("#lane-detail .close");
    if (closeBtn) closeBtn.addEventListener("click", () => { selectedLane = null; renderDetail(); });
  }

  /** Dedicated rollup of this lane's gate_result events (one per validation
   *  attempt), split out from the raw event stream so pass/fail per
   *  deterministic check is immediately legible - mirrors sssf's PhaseDetail
   *  "gates" panel, which never mixes gate verdicts into the plain event log. */
  function renderGatesSection(gateEvents) {
    if (!gateEvents.length) return "";
    const blocks = gateEvents.map(e => {
      const checks = (e.data && e.data.checks) || [];
      const failed = checks.filter(c => !c.ok).length;
      const passed = failed === 0;
      const rows = checks.map(c => \`
        <div class="gate-check-row \${c.ok ? "pass" : "fail"}">
          <span class="cm">\${c.ok ? "&#10003;" : "&#10007;"}</span>
          <span class="cname">\${c.name}</span>
          <span class="cdetail">\${c.detail}</span>
        </div>\`).join("");
      return \`
      <div class="gate-block \${passed ? "pass" : "fail"}">
        <div class="gate-block-head">
          <span class="gm \${passed ? "pass" : "fail"}">\${passed ? "&#10003;" : "&#10007;"}</span>
          <span>attempt \${e.data && e.data.attempt != null ? e.data.attempt : "?"}</span>
          <span class="gsummary">\${passed ? \`\${checks.length}/\${checks.length} passed\` : \`\${failed} of \${checks.length} failed\`} &middot; \${new Date(e.ts).toLocaleTimeString()}</span>
        </div>
        \${rows}
      </div>\`;
    }).join("");
    return \`<div class="ld-section-h">&#128737; deterministic gates (no LLM judge) &middot; \${gateEvents.length} attempt(s)</div>\${blocks}\`;
  }

  function renderLaneDetail(lane) {
    if (!lane) return "";
    const gateEvents = lane.evts.filter(e => e.type === "gate_result");
    const otherEvents = lane.evts.filter(e => e.type !== "session_start" && e.type !== "gate_result");
    const items = otherEvents.map(e => {
      const isErr = e.data && e.data.isError;
      const cls = e.type + (isErr ? " err" : "") + (e.data && e.data.ok === false ? " failed" : "");
      const toolLabel = e.data && e.data.toolName ? \`<span class="ld-tool">\${e.data.toolName}</span>\` : "";
      let detail = "";
      if (e.type === "tool_call" && e.data && e.data.args) detail = JSON.stringify(e.data.args);
      else if (e.data) detail = JSON.stringify(e.data);
      return \`<div class="ld-event \${cls}">
        <div class="ld-line1">
          <span class="ld-ts">\${new Date(e.ts).toLocaleTimeString()}</span>
          <span class="ld-type">\${e.type}</span>
          \${toolLabel}
        </div>
        \${detail ? \`<pre class="ld-detail-pre">\${detail}</pre>\` : ""}
      </div>\`;
    }).join("");
    return \`<div id="lane-detail">
      <div class="ld-head">
        <span class="name">\${lane.role} &middot; \${lane.toolCount} tool call(s)\${lane.errorCount ? " &middot; " + lane.errorCount + " error(s)" : ""}</span>
        <button class="close">&times;</button>
      </div>
      <div class="ld-body">
        \${renderGatesSection(gateEvents)}
        <div class="ld-section-h">&#128337; events (\${otherEvents.length})</div>
        \${items || '<div class="empty">No events</div>'}
      </div>
    </div>\`;
  }

  async function loadSessions() {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    if (!selectedId && sessions.length > 0) selectedId = sessions[0].session_id;
    // Prefetch events for the most recently active sessions so the list can
    // draw mini-timelines without a request per hover.
    const toFetch = sessions.slice(0, 20).map(s => s.session_id);
    if (selectedId && !toFetch.includes(selectedId)) toFetch.push(selectedId);
    await Promise.all(toFetch.map(async id => {
      const r = await fetch("/api/events?session=" + encodeURIComponent(id));
      eventsCache.set(id, await r.json());
    }));
  }

  async function refresh() {
    await loadSessions();
    renderSessions();
    renderDetail();
  }

  refresh();
  // Redraw every second so a running agent's block keeps growing toward "now"
  // even between events (e.g. while it's mid-turn with no tool calls yet) -
  // the file-watch SSE alone only fires when a new event line is appended.
  setInterval(() => {
    if (sessions.some(s => s.status === "running")) {
      renderSessions();
      renderDetail();
    }
  }, 1000);
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
