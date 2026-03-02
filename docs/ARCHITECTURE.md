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
├── dm(from, to, text) → private message, persists + notifies only sender & recipient
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

`receive()` pushes the message into the participant's stimulus queue. The participant processes stimuli asynchronously and may call `room.post()` to respond. `receive()` itself is non-blocking — it enqueues and returns immediately.

### Agent / Participant Split

Cognition and room wiring are separated into two layers:

```
Agent (interface)        — pure cognitive core
├── handle, displayName
└── think(AgentContext) → AgentResponse | null

AgentParticipant         — adapts any Agent into a Participant
├── owns stimulus queue + sleep/wake loop
├── assembles AgentContext from Room history
└── routes AgentResponse → room.post() or room.dm()

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
    internalMessages: Message[];  // recent self-notes for this agent
    stimuli: Message[];           // new unprocessed messages
    isMentioned: boolean;         // @handle detected in stimuli
    dmSenders: string[];          // handles that sent DMs in this batch
}

interface AgentResponse {
    text: string;          // markdown message to post
    dm?: string;           // if set, send as DM to this handle
    internal?: boolean;    // if true, store as internal self-note
}

interface Agent {
    handle: string;
    displayName: string;
    think(context: AgentContext): Promise<AgentResponse | null>;
}
```

`AIParticipant` is kept as a backward-compat wrapper that creates an `LLMAgent` + `AgentParticipant` internally.

### Internal Pack System

Ivy uses **self-contained internal packs** (local source files only) for extension points.
No external pack loading is supported.

There are currently two internal pack surfaces:

1. **Agent packs** (for cognition prompt construction)
   - `IvyAgentPack.register({ promptRegistry })`
   - Booted by `LLMAgent` via `bootInternalPacks(...)`
   - Current default: `core-prompt` pack
   - Registers prompt contributors (identity, history, stimuli, mention hint, DM hint)

2. **Participant packs** (for routing/policy guards)
   - `IvyParticipantPack.register({ registerRoutingGuard })`
   - Booted by `AgentParticipant` via `bootInternalParticipantPacks(...)`
   - Current default: `routing-guard` pack
   - Enforces handle-aware routing checks (unknown DM targets / unknown @mentions)

Internally, `LLMAgent` uses:
- `PromptContributorRegistry` to collect contributor sections
- `PromptEngine` to compose with token budget
- `AIPromptService.pipeline().llm().transform().retry().run()` for model call + validation/retry

### Human Participant (Telegram Adapter)

The human participant bridges Telegram into the room via the gears **notifications** bundle:
- Inbound: listens for `notification:receive` events on `IEventBus` and posts them to the room.
- Outbound: receives room messages (via `receive()`) and emits `notification:send` events to Telegram.

No stdin. The human interacts entirely through Telegram.

## Service Wiring

```
IvyServiceProvider.register()
├── binds ivy.RoomLog (singleton, backed by SharedDatabase)
└── binds ivy.Room (singleton, wraps RoomLog)

bundle.init(app)
├── resolves ivy.Room, ILLMProvider, IEventBus, ILogger
├── creates LLMAgent instances (Ivy, Nova) — cognitive cores
├── wraps each in AgentParticipant — room adapters
├── creates TelegramParticipant (Architect)
├── registers all participants with the room
└── starts each participant's processing loop
```

Ivy declares `requires: ['notifications']` so the notifications bundle
is always booted first (Telegram polling is active before ivy starts).

## Key Design Decisions

1. **Worker-only.** No CLI commands, no TUI. Ivy lives in `npx gears work`.
2. **IEventBus for Telegram bridge.** The TelegramParticipant uses `notification:receive` and `notification:send` events from the notifications bundle — no direct Telegram dependency.
3. **ILLMProvider for agent cognition.** `LLMAgent` wraps it through `AIPromptService` fluent pipelines and internal prompt contributors.
4. **IStore for transient state.** *(not yet used)* Ephemeral data (not the message log) can use `IStore`.
5. **No orchestration.** Agents observe and self-select. No router, no turn-taking, no manager.
6. **Three routing modes.** `post()` for public broadcast, `dm()` for private messages, and `note()` for internal self-reflection. All three share the same persistent log table.
