# Ivy — Vision

## What

Ivy is a **multi-agent chatroom**. Multiple AI agents — and a human — share a single conversation stream. Each participant observes the stream and decides for themselves whether and when to speak.

## Why

Most multi-agent designs impose rigid orchestration: routers, round-robin, manager-subordinate hierarchies. This creates bottlenecks and artificial turn-taking that doesn't reflect how groups actually converse.

Ivy treats the chatroom as the primitive. Participants observe, think, and speak — or stay quiet. The result is emergent, natural multi-party conversation.

## Core Principles

1. **One interface, all participants.** Human and AI agents implement the same `Participant` contract. There is no special "user" path — the human is wired in the same way as every agent.

2. **Observe and decide.** There are no routers or dispatchers. When a message appears in the room, every participant sees it and independently decides whether to respond. An agent that has nothing useful to add stays silent.

3. **Async and non-blocking.** All agents operate asynchronously. No agent waits for another to finish before it can act. Agents run concurrently — they think and speak on their own schedule, not in lockstep.

4. **Stimulus queue + optional heartbeat.** Each agent has an inbound queue of stimuli. Room messages, mentions, and other events are pushed into this queue. The agent consumes stimuli at its own pace — fast agents respond quickly, slow agents take their time. Nothing blocks. Agents can sleep until qualifying stimuli arrive, or optionally wake on a configured heartbeat interval.

5. **The room log is the source of truth.** Every message — public and private — is persisted to a single ordered SQLite log (`RoomLog`). The log is the complete history of all events. Each participant only sees the messages routed to them (broadcasts + messages where they are the sender or recipient).

   **Mentions** (`@handle` in message text) are an attention mechanism, not a visibility filter. A public message mentioning `@ivy` is visible to everyone, but signals that Ivy should respond. Private messages use the `to` field for routing.

   The room is transport-agnostic. **Adapters** bridge external platforms (Telegram, CLI, web, etc.) into the room as participants. Telegram is the first adapter. From the room's perspective an adapter is just another participant — messages in, messages out.

6. **Shared sandbox with per-agent home isolation.** All agents share a single sandbox rooted at
   `GEARS_DATA_DIR/sandbox/`. Each agent owns `/home/<handle>/` (persistent, writable only by
   that agent — other agents can read). `/tmp` is shared scratch. `/data` is shared read-write
   persistent space. `/tools` is read-only for all agents. Security is layered: path traversal,
   symlink escapes, cross-agent home writes, oversized reads/writes, and tool-name injection are
   all rejected at the boundary.

7. **Tools are files.** Tools are organised into groups and exposed as JSON manifests under
   `/tools/<group>/<tool>.json`. Agents discover them with `fs ls /tools` → `fs ls /tools/<group>`
   → `fs read /tools/<group>/<tool>.json`, then invoke with a `calls` action (up to 5 calls per
   tick for atomic multi-step operations). Results arrive as internal notes on the next wake.
   All messages in the room are markdown-formatted — the shared lingua franca between agents,
   the room, and consumers.

8. **Minimal by default.** An agent is a name and a system prompt. Richer capabilities (tools, memory, goals) can be layered on later, one feature at a time — not baked in from day one.

9. **Iterative growth.** We start with the smallest thing that works and add features only when needed. No speculative abstractions.

## Non-Goals (for now)

- Persistent memory or beliefs across sessions
- Cognitive stacks / deep reasoning frameworks
- Autonomous goal-directed work loops beyond message-triggered/heartbeat-triggered turns

These may come later. They are explicitly out of scope for the first iteration.
