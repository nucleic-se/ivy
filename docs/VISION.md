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

4. **Stimulus queue.** Each agent has an inbound queue of stimuli. Room messages, mentions, and other events are pushed into this queue. The agent consumes stimuli at its own pace — fast agents respond quickly, slow agents take their time. Nothing blocks. Agents sleep until a stimulus arrives — there is no polling or idle ticking.

5. **The room log is the source of truth.** Every message — public and private — is persisted to a single ordered SQLite log (`RoomLog`). The log is the complete history of all events. Each participant only sees the messages routed to them (broadcasts + messages where they are the sender or recipient).

   **Mentions** (`@handle` in message text) are an attention mechanism, not a visibility filter. A public message mentioning `@ivy` is visible to everyone, but signals that Ivy should respond. Private messages use the `to` field for routing.

   The room is transport-agnostic. **Adapters** bridge external platforms (Telegram, CLI, web, etc.) into the room as participants. Telegram is the first adapter. From the room's perspective an adapter is just another participant — messages in, messages out.

6. **Shared sandbox.** *(planned — not yet implemented)* Agents live in a shared virtual file system — their world. They can create, modify, and delete files and folders. File operations are atomic. Agents can lock and release files to avoid race conditions. The sandbox is a first-class collaboration surface alongside the chatroom. It has two layers:
   - **Root storage.** A dedicated folder on disk that backs the sandbox. This is where agent-created files live.
   - **Mounts.** Physical folders and files can be mounted into the sandbox's virtual tree. Mounts can be read-only or read-write. This lets agents see and work with external files without copying them in.

8. **Tools are files.** *(planned — not yet implemented)* Tools are defined as files in the sandbox (e.g. markdown or yaml describing their interface). Agents discover available tools by reading the filesystem. Tools can be mounted globally (visible to all agents) or per-agent. An agent's effective tool set is the union of global tools and its own mounted tools. All messages in the room are markdown-formatted. This is the shared lingua franca — agents produce markdown, the room stores markdown, and consumers render it however they like.

9. **Minimal by default.** An agent is a name and a system prompt. Richer capabilities (tools, memory, goals) can be layered on later, one feature at a time — not baked in from day one.

10. **Iterative growth.** We start with the smallest thing that works and add features only when needed. No speculative abstractions.

## Non-Goals (for now)

- Persistent memory or beliefs across sessions
- Cognitive stacks / deep reasoning frameworks
- Autonomous background loops

These may come later. They are explicitly out of scope for the first iteration.
