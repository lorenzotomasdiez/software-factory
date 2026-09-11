# References

Prior art and adjacent projects worth re-reading before making architecture decisions on this harness.
Each entry is a pointer, not a spec - go read the source when a decision actually depends on the details.

## pi

Path: `~/repos-to-learn-from/pi`

The Pi agent CLI itself (`@earendil-works/pi-coding-agent`), built as a monorepo: `pi-agent-core` (runtime, tool calling, state), `pi-ai` (unified multi-provider LLM API), `pi-tui` (terminal UI), `pi-telemetry` (vendor-neutral telemetry contracts).

Extension system is the key thing to reuse.
TypeScript modules auto-discovered from `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local), hot-reloadable via `/reload`.
Extensions get a real event API (`pi.on("tool_call", ...)`, `session_start`, etc.), can block or mutate tool calls before they execute, register custom tools/commands/shortcuts, drive custom TUI via `ctx.ui`, and persist state across restarts.
Docs: `packages/coding-agent/docs/extensions.md`.
Pi has no built-in permission system - it runs with the launching user's full permissions unless you containerize it yourself.

Relevance: this is the richest observe/modify surface of any agent in this survey.
Any "modify Claude vs modify Pi" asymmetry starts here - Pi lets an extension intercept and block a tool call inline; Claude Code's hooks are external processes with a coarser JSON contract.

## fusion-harness

Path: `~/repos-to-learn-from/fusion-harness`

A mature Pi extension (not a standalone app) that runs 2-5 frontier models in parallel inside one Pi session instead of picking one.
Roles: one architect, one primary "builder" host, up to three secondary builders.
Modes: `/fh-opinion` (parallel read-only answers), `/fh-debate` (N-way debate, no judge), `/fh-fusion` (parallel read-only research, one temporary agent is the sole writer, then syncs the fused result to everyone with ACK evidence), `/fh-collaborate` (architect merges per-agent plans into a dependency DAG, tasks execute with exactly one write-enabled child at a time).

The single-writer invariant is the important primitive: multiple agents can read concurrently, but a writer-lease token ensures only one of them ever holds write access to the shared working directory at a time.
Implementation lives in `extensions/fusion-harness/modules/writer-lease.ts` and `modules/collaboration-graph.ts`.

Relevance: closest existing solution to "agents talking to each other" and safe concurrent execution against one repo.
Reuse the writer-lease and DAG-delegation pattern rather than re-deriving it.

## super-simple-software-factory (sssf)

Path: `~/repos-to-learn-from/super-simple-software-factory`

A Claude Code skill, stamped into any target repo via `/sssf install`, that inverts the "agent owns the loop" model: deterministic Python (an "ADW" - AI Developer Workflow script) owns sequencing, retries, and acceptance criteria; agents are bounded nodes inside named phases; typed JSON envelopes carry context across phase boundaries; every event streams into SQLite as it happens, watchable live via a trace UI (`just obs`).

Distribution model: everything needed lives under `.claude/skills/sssf/`, and `install.py` stamps config/workflows/prompts into the target repo, skipping files that already exist (idempotent, `--force` to overwrite).
Per-agent model/prompt/tools/context configured in one `sssf.config.yaml`.

Relevance: closest existing solution to (a) full observability via a durable event trace and (b) "install once into any repo" distribution without per-project manual setup.
The "code owns the loop, agent owns one phase" philosophy is also the strongest opinion in this survey about what a harness should NOT let agents do freely.

## builder

Path: `~/projects/builder`

An earlier, less mature "agent-first framework" meant to be copied into projects: skills (`smart-commit`, `ref-only`, `skill-generator`, `mermaid-diagrams`, `find-skills`) plus Pi extensions (`extensions/build-api.ts`, `build-infra.ts`, a subagent TUI widget) plus doc scaffolding (design docs, exec plans, product specs).
Includes a 4-layer browser QA stack (Playwright CLI + Chrome MCP + QA agents + justfile recipes).

Relevance: lower signal than the other four - mostly useful for its `extensions-examples/` as reference Pi extension code, and as a cautionary example of a framework that didn't fully converge (no top-level README, TODO.md still tracking an unfinished "Build-Infra" plan).

## firstmate

Path: `~/firstmate`

An "agent distro" (their term, not framework/harness/CLI) for running a supervised crew of autonomous agents across **multiple harnesses**: Claude Code, Grok, Pi (and `pi-signed`), Codex, and OpenCode are all supported as the "first mate" (the one agent you talk to).
You describe work; the first mate spawns crewmates, each in its own disposable git worktree (via `treehouse`) and its own visible terminal session (tmux by default, or herdr/zellij/Orca/cmux), supervises them to completion, and hands back PRs or investigation reports.

Key mechanisms:
- **Per-harness supervision integration** - Claude Code uses a tracked Stop hook for tokenless watcher re-arm; Grok uses background-notify wake cycles; Pi uses a tracked primary watcher extension (`.pi/extensions/*.ts`). Each harness gets a bespoke turn-end guard so the first mate is woken only when something needs a decision (event-driven, "zero-token" supervision - no polling).
- **Guarded-by-construction permissions** - the first mate itself is read-only over project code except explicitly authorized paths; only crewmates make changes, and only behind the project's configured merge authority (`no-mistakes`, `direct-PR`, or `local-only` modes, optional `+yolo`).
- **Restart-proof state** - everything lives on disk plus the session backend, so killing a session and restarting just reconciles.
- **Optional persistent secondmates** - additional first mates with their own isolated `FM_HOME`, useful for fleets bigger than one first mate can supervise.
- No install step - the cloned repo IS the distro (`AGENTS.md` + skills + scripts any terminal agent can follow).

Relevance: the closest existing template for "one control plane on top of multiple agent CLIs, observing and orchestrating them, usable from any project" - which is close to this project's core goal.
The main difference from what we want: firstmate's unit of work is a whole autonomous task handed to a disposable crewmate in its own worktree, whereas we also want tighter in-session observation/modification (Pi extension-style interception) and direct agent-to-agent communication within a shared working tree (closer to fusion-harness's model), not just fleet-level task dispatch.
Read `docs/architecture.md` and `AGENTS.md` in that repo before designing the harness's supervision/watcher layer - no need to reinvent per-harness wake/hook plumbing.

## Recommendation (carried over from initial scouting)

No single repo above is "the answer" - each solves one slice:

- **Observe/modify inside a session** -> Pi's extension API directly; Claude Code hooks (`settings.json`, `PreToolUse`/`PostToolUse`/etc.) as the coarser equivalent for Claude.
- **Agent-to-agent coordination on a shared working tree** -> fusion-harness's writer-lease + collaboration-graph pattern.
- **Durable observability / event trace** -> sssf's SQLite-per-event model.
- **Fleet-level supervision across harnesses, from any project, no per-project setup** -> firstmate's distro model and per-harness watcher/hook integration.
- **Multi-harness abstraction line to draw explicitly** -> Claude Code is more locked down than Pi; design the abstraction so Claude-side capabilities are a strict subset, not the lowest common denominator that limits what Pi can do.
