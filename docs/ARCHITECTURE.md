# Ivy — Architecture

## Overview

Ivy runs as a background service inside `npx gears work`. It has no TUI — all interaction happens through adapters (Telegram, CLI, etc.). The bundle's `init()` boots the chatroom and wires participants.

## Core Concepts

### Room + RoomLog

The **Room** is the central message bus. It delegates persistence to **RoomLog**, which stores every message (public and private) in a single SQLite table (`ivy_messages`). Participants are notified only of messages visible to them.

```
RoomLog (SQLite)
├── append(from, to, text) → persists message, returns Message
├── getVisibleTo(handle, limit) → filtered read (to='*' OR to=handle OR from=handle)
├── getPublic(limit) → broadcast-only read (to='*')
├── getPrivate(handle, limit) → DM messages involving handle (excludes self-notes)
├── getInternal(handle, limit) → self-notes (from=to=handle)
├── getAll(limit) → unfiltered read
└── count() → total message count

Room
├── join(participant) → register a participant (throws if duplicate handle)
├── leave(handle) → remove a participant (throws if not present)
├── hasParticipant(handle) → boolean membership check
├── post(from, text) → broadcast (to='*'), persists + notifies visible participants
├── dm(from, to, text) → private message, persists + notifies recipient only (sender sees it via history)
├── note(from, text) → internal self-note (from=to=sender), persisted but not broadcast
├── getVisibleTo(handle, limit)
├── getPublic(limit) → delegates to RoomLog.getPublic()
├── getPrivate(handle, limit) → delegates to RoomLog.getPrivate()
├── getInternal(handle, limit) → delegates to RoomLog.getInternal()
├── getAll(limit)
└── getParticipants() → [{handle, displayName}] snapshot of joined members
```

### Message

```typescript
interface Message {
    id: string;
    from: string;       // participant handle, e.g. "@ivy"
    to: string;         // '*' for broadcast, or a handle for private message
    text: string;       // markdown
    timestamp: number;
}
```

Visibility rule: a message is visible to a participant if `to === '*'` OR `to === handle` OR `from === handle`.
Internal notes use `from === to` (self-to-self), so only the owner can see them in history reads.

### Participant

Every entity in the room — AI agent or human adapter — implements the same interface:

```typescript
interface Participant {
    handle: string;              // e.g. "@ivy"
    displayName: string;         // e.g. "Ivy"
    receive(message: Message): void;  // called by the room on every new message
}
```

`receive()` is non-blocking, but behavior is adapter-specific. `AgentParticipant` enqueues stimuli for async processing; transport participants like `TelegramParticipant` forward immediately to their transport layer.

### Agent / Participant Split

Cognition and room wiring are separated into two layers:

```
Agent (interface)        — pure cognitive core
├── handle, displayName
└── think(AgentContext) → AgentAction[]

AgentParticipant         — adapts any Agent into a Participant
├── owns stimulus queue + sleep/wake loop (+ optional heartbeat)
├── assembles AgentContext from Room history
├── routes AgentAction[] → room.post(), room.dm(), room.note(), local config changes,
│   or sandbox action handlers (fs/call → result posted as room.note())
└── applies routing guards to speak/dm before dispatch

LLMAgent (implements Agent)
├── system prompt + optional token budget
├── assembles LLM prompt from internal prompt contributors
└── calls fluent LLM pipeline (AIPromptService) → structured JSON decision

TelegramParticipant      — adapts Telegram into a Participant
├── inbound: notification:receive → room.post()
└── outbound: receive() → notification:send
```

**Why the split?** The Agent interface knows nothing about rooms, queues, or transport. This means:
- Agent cognition can be tested in isolation (mock LLM, assert on prompt/response).
- The adapter (AgentParticipant) can be tested with a stub Agent (no LLM needed).
- Future agent capabilities (tools, memory) attach to the Agent layer without touching Room plumbing.

```typescript
interface AgentContext {
    publicMessages: Message[];    // recent public transcript
    privateMessages: Message[];   // recent DMs involving this agent
    internalMessages: Message[];  // recent self-notes (includes sandbox results)
    stimuli: Message[];           // new unprocessed messages
    isMentioned: boolean;         // @handle detected in stimuli
    dmSenders: string[];          // handles that sent DMs in this batch
    wakeMode: 'all' | 'mentions' | 'dm' | 'none';
    heartbeatMs: number | null;
}

type AgentAction =
    | { type: 'speak'; text: string }
    | { type: 'dm'; to: string; text: string }
    | { type: 'note'; text: string }
    | { type: 'configure'; wakeOn?: 'all' | 'mentions' | 'dm' | 'none'; heartbeatMs?: number | null }
    | { type: 'fs'; op: 'read' | 'write' | 'ls' | 'mkdir' | 'rm' | 'mv' | 'stat'; path: string; content?: string; dest?: string; recursive?: boolean }
    | { type: 'call'; tool: string; args?: Record<string, unknown> };

interface Agent {
    handle: string;
    displayName: string;
    think(context: AgentContext): Promise<AgentAction[]>;
}
```

`AIParticipant` is kept as a backward-compat wrapper that creates an `LLMAgent` + `AgentParticipant` internally.

### AgentAction dispatch order

`AgentParticipant.process()` dispatches actions in this fixed order:

1. **configure** — applied immediately so subsequent actions see the new state
2. **note** — written directly to internal history, no guards
3. **fs / call** — dispatched to registered action handlers; result posted as `room.note()` after each await; run-version checked to prevent stale writes after stop/restart. For batched `call` actions: if one fails, remaining calls are skipped and a `[batch] N remaining call(s) skipped` note is posted.
4. **speak / dm** — passed through routing guards, then dispatched

### Internal Pack System

Ivy uses **self-contained internal packs** (local source files only) for extension points.
No external pack loading is supported.

There are two internal pack surfaces:

1. **Agent packs** (`IvyAgentPack`) — for prompt construction
   - `register({ promptRegistry })`
   - Booted by `LLMAgent` via `bootInternalPacks(...)`
   - Default pack: `core-prompt`
   - Optional pack: `sandbox` (registered when `LLMAgentConfig.sandbox` is set)
   - Registers prompt contributors (identity, history, stimuli, mention hint, DM hint, sandbox docs)

2. **Participant packs** (`IvyParticipantPack`) — for routing/policy and action handling
   - `register({ registerRoutingGuard, registerActionHandler })`
   - Booted by `AgentParticipant` via `bootInternalParticipantPacks(...)`
   - Default pack: `routing-guard`
   - Optional pack: `sandbox` (registered when `AgentParticipantConfig.sandbox` is set)
   - Enforces handle-aware routing checks; registers `fs` and `call` action handlers (each `CallAction` represents one tool call; the LLM emits a `calls[]` array that maps to multiple `CallAction` entries)

Internally, `LLMAgent` uses:
- `PromptContributorRegistry` to collect contributor sections
- `PromptEngine` to compose with token budget
- `AIPromptService.pipeline().llm().transform().retry().run()` for model call + validation/retry

### Sandbox

All agents share a **single sandbox** rooted at `GEARS_DATA_DIR/sandbox/`. Each agent's home
directory lives at `/home/<handle>/` within that shared root.

```
GEARS_DATA_DIR/sandbox/
├── home/
│   ├── ivy/      — Ivy's private workspace (read-write for @ivy only; readable by others)
│   └── nova/     — Nova's private workspace (read-write for @nova only; readable by others)
├── tmp/          — scratch space, shared by all agents (read-write, may be cleared)
├── tools/        — tool manifests as JSON (read-only for all agents, written by host)
└── data/         — shared workspace for all agents (read-write, persistent)
```

**Security model** (all enforced in code, not just policy):

| Threat | Mitigation |
|---|---|
| `../` path traversal | `path.normalize()` at entry + `path.resolve()` string check |
| Symlink escape | `realpathSync()` on existing paths; nearest-ancestor check for write targets |
| Write to `/` or `/tools` | `assertWritable()` rejects any path starting with `/` or `/tools` |
| Cross-agent home writes | `assertHomeOwner()` rejects writes/mkdir/rm/mv to `/home/<other>` or `/home/<other>/...` by a non-owner; ownership is identity-based (registered handle set), not filesystem-state-based — protection persists even if the directory is deleted |
| `rm` of top-level dirs | `assertNotProtected()` rejects `/`, `/home`, `/tools`, `/data`, `/tmp` |
| Tool name path injection | `registerTool()` validates name against `^[a-zA-Z0-9_-]+$` |
| Memory/context exhaustion | Reads capped at 512 KB; write content capped at 512 KB |
| Bad manifest bricking prompts | `listTools()` wraps `JSON.parse` in try/catch, silently skips malformed files |
| Root path symlink (e.g. macOS `/tmp`) | Constructor calls `realpathSync(root)` and stores the canonical path |

**fs/call async flow:**

Agents emit `fs`/`call` actions, which are dispatched by `AgentParticipant` to the registered
`SandboxParticipantPack` handlers. Each handler executes the operation and posts the result string
as an internal note (`room.note()`). The agent sees the result in `internalMessages` on its next
wake, one turn later.

**Tool discovery:** tools are organised into groups via `ToolGroupPack`, mounted at `/tools/<group>/`.
Agents discover them with `fs ls /tools` → `fs ls /tools/<group>` → `fs read /tools/<group>/<tool>.json`.
The `SandboxToolsContributor` also renders a grouped summary in the prompt.
Call: `calls: [{ "tool": "text/write", "args": {...} }]` — up to 5 calls per tick, batch-aborted on first failure.

**Built-in tool groups:**

| Group | Tools | Description |
|---|---|---|
| `text/*` | `read`, `write`, `insert`, `replace`, `delete_lines`, `search`, `find`, `grep`, `to_markdown`, `tree`, `patch` | Rich text/file editing with 1-based line numbers |
| `fetch/*` | `get`, `post` | HTTP fetch/post — saves to sandbox or returns inline; HTML auto-converted to Markdown via Defuddle |
| `fs/*` | `diff` | Unified diff between two sandbox files |
| `json/*` | `get`, `set`, `del`, `validate` | JSON Pointer read/write/delete + JSON Schema validation |
| `validate/*` | `run` | Compliance scan (index presence, manifest integrity, broken refs, context schema) |
| `schedule/*` | `set`, `list`, `cancel` | Cron and one-shot scheduling; per-agent state, survives restarts via IStore |
| `history/*` | `view`, `search` | Paginated view and text search of room history; privacy-enforced per callerHandle |

### Human Participant (Telegram Adapter)

The human participant bridges Telegram into the room via the gears **notifications** bundle:
- Inbound: listens for `notification:receive` events on `IEventBus`; posts plain text to the room and handles slash commands (`/pm`, `/who`).
- Outbound: receives room messages (via `receive()`) and emits `notification:send` events to Telegram.

No stdin. The human interacts entirely through Telegram.

## Service Wiring

```
IvyServiceProvider.register()
├── binds ivy.RoomLog (singleton, backed by SharedDatabase)
└── binds ivy.Room (singleton, wraps RoomLog)

bundle.init(app)
├── resolves ivy.Room, ILLMProvider, IEventBus, ILogger, IFetcher
├── resolves IScheduler and IStore (optional — graceful degradation if absent)
├── creates shared Sandbox — one root, per-agent home dirs under /home/<handle>/
├── mounts tool groups: TextToolPack, FetchToolPack, FsToolPack, ValidateToolPack, JsonToolPack, HistoryToolPack
├── mounts ScheduleToolPack (per-agent, routed by callerHandle)
├── creates LLMAgent instances (Ivy, Nova, Sentinel) — cognitive cores with sandbox prompt contributors
├── wraps each in AgentParticipant — room adapters with sandbox action handlers
│   └── Sentinel starts in 'mentions' wake mode
├── creates TelegramParticipant (Architect)
├── wires ScheduleToolPack observe callbacks → participant.observe()
├── awaits schedulePack.boot() — restores persisted schedules
├── registers all participants with the room
├── starts each participant's processing loop
└── runs integrity gate (startup) + schedules recurring 30-min cron check
```

### Integrity Gate

On every startup and every 30 minutes (cron `*/30 * * * *`), the bundle runs an automated
integrity check over `/home` and `/data` (intentionally excluding `/tmp` which is scratch space).
It uses `validate/run` directly — without going through an agent turn — and posts results as
DMs from `@sentinel` to `@architect` and `@ivy` if violations are found. Errors are also DM-ed
to `@architect`. The gate is non-blocking: a failure is reported but never prevents startup.

```
runIntegrityGate(trigger: 'startup' | 'scheduled')
├── calls sandbox.execCall('validate/run', { path: scope }) for each of /home, /data
├── if violations.length > 0  → room.dm('@sentinel', '@architect', summary)
│                             → room.dm('@sentinel', '@ivy', summary)
└── on error                  → room.dm('@sentinel', '@architect', error)
```

Ivy declares `requires: ['notifications']` so the notifications bundle
is always booted first (Telegram polling is active before ivy starts).

## CLI Commands

Ivy registers one CLI command accessible via `gears ivy <command>`:

| Command | Description |
|---|---|
| `gears ivy log` | Analyse the room message log — prints volume by type, by sender, DM pairs, daily activity, hourly heatmap, and a recent timeline |

**`gears ivy log` options:**

| Flag | Default | Description |
|---|---|---|
| `--tail <n>` | 30 | Number of recent public messages shown in the timeline |
| `--since <date>` | — | Filter to messages on or after this date (YYYY-MM-DD) |
| `--dm` | false | Show recent private DMs in the timeline instead of public messages |

The command reads `ivy_messages` directly from `shared.sqlite` using a read-only connection.
Safe to run while the worker is live.

## Key Design Decisions

1. **Worker-first.** No TUI. Ivy lives in `npx gears work`. CLI commands (e.g. `gears ivy log`) are read-only diagnostics — they do not affect the running room.
2. **IEventBus for Telegram bridge.** The TelegramParticipant uses `notification:receive` and `notification:send` events from the notifications bundle — no direct Telegram dependency.
3. **ILLMProvider for agent cognition.** `LLMAgent` wraps it through `AIPromptService` fluent pipelines and internal prompt contributors.
4. **IStore for transient state.** Ephemeral key-value data (not the message log) is accessed via `IStore`. Currently used by `ScheduleToolPack` to persist scheduled jobs across restarts.
5. **IFetcher for outbound HTTP.** The `FetchToolPack` delegates all HTTP calls to `IFetcher` — no direct `fetch`/`axios` dependency. HTML responses are converted to Markdown via Defuddle before being saved to the sandbox.
6. **No orchestration.** Agents observe and self-select. No router, no turn-taking, no manager.
7. **Three routing modes.** `post()` for public broadcast, `dm()` for private messages, and `note()` for internal self-reflection. All three share the same persistent log table.
8. **Runtime attention control.** Agents can reconfigure `wakeOn` and optional `heartbeatMs` at runtime via `configure` actions.
9. **Shared sandbox with per-agent home isolation.** All agents share a single sandbox root at `GEARS_DATA_DIR/sandbox/`. Each agent owns `/home/<handle>/` (writable only by its owner, readable by all). `/data` is shared read-write persistent space; `/tmp` is shared scratch. Tool packs are mounted once on the shared instance. The ACL is identity-based: ownership is registered at boot and cannot be vacated by deleting the home directory.
10. **Async sandbox results.** `fs`/`call` results are delivered as internal notes on the next wake, not inline. This keeps the action-dispatch loop simple (one think per tick) and makes sandbox latency visible to agents.
11. **Automated integrity gate.** On startup and every 30 minutes the bundle runs `validate/run` over `/home` and `/data` without agent involvement and DMs violations to `@architect` and `@ivy`. This decouples compliance enforcement from agent availability.
12. **Prompt-enforcement consistency.** Every security constraint stated in the agent prompt (read-only zones, size limits) is backed by a corresponding runtime check. Prompt and enforcement never diverge.
