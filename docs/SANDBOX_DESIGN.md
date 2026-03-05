# Sandbox Design — Insights, Best Practices & Foundational Guidelines

_How to structure a self-organising multi-agent system in the Ivy sandbox._

---

## Overview

This document captures hard-won lessons from operating the Ivy sandbox across multiple iterations. It is written for engineers and architects who want to understand why the system is designed the way it is, and how to extend or replicate it correctly.

The central thesis: **a well-structured sandbox is a cognitive prosthetic for LLM agents**. The filesystem is not just storage — it is working memory, program counter, audit trail, and coordination medium all at once. Design it accordingly.

---

## Part 1 — What We Learned the Hard Way

### 1.1 Compliance Regimes Compete with Work

The first version of the sandbox had 14 mandatory protocol documents. Every agent was expected to read all of them before starting any task. The result:

- Agents spent significant context budget on protocol coverage checks
- `validate/run` was a source of anxiety rather than a quick gate
- Agents would halt on ambiguous protocol coverage rather than using judgment
- The "Protocol Gap Warning" rule caused agents to flag non-issues and interrupt the work stream

**Lesson:** Mandatory compliance overhead has a direct cost in task throughput and agent confidence. The right model is a small set of internalised core rules plus a reference library consulted only when relevant.

### 1.2 Stale Rules Are Worse Than No Rules

When the CONTEXT.md schema changed (8 fields → 5 fields) but the validator was not updated, every agent boot failed the `CONTEXT_SCHEMA` check. The agents received false positives on every tick, eroding trust in the validation system.

Similarly, AGENTS.md files that referenced deleted protocol documents (`HEARTBEAT.md`, `HOME.md`) created broken anchors that confused agents on first wake.

**Lesson:** Documentation and code enforcement must change together. The validator is the source of truth, not the docs. If you update the schema, update the validator first.

### 1.3 The Sandbox Rearrangement Test

When the operator reorganised the sandbox mid-session and told the agents "your memories might not align with current state", the agents' responses revealed a lot about system health:

- **Healthy response:** Re-map using `text/tree`, update CONTEXT.md, resume work
- **Unhealthy response (pre-cleanup):** Continue operating from stale mental model, produce stale tool paths

The new system passed this test. Agents read the new tree, self-corrected, and continued. This is the correct behaviour and it emerges from a simple rule: always read before you write; use `text/tree` when disoriented.

### 1.4 Blockers Must Be Named and Parked

When the `steward/pulses/` directory was missing, the old system had nova stuck in a loop — no mechanism to document the blocker, no escalation path, no graceful standby. The agent consumed ticks producing nothing.

With RECOVERY.md and the CONTEXT.md `Blockers:` field in place, nova wrote:
```
Current Task: standing-by (steward-path-regression)
Blockers: Steward path regression (/data/projects/steward/pulses/)
```
...and went quiet. The blocker was visible to @ivy, who coordinated the fix. No wasted ticks.

**Lesson:** Every agent needs a formal mechanism to park a blocker. Idle is better than spinning. The blocker format should be specific enough that another agent (or the operator) can act on it without asking for clarification.

### 1.5 The Hash-Stale Pattern Is a Feature

`text/write` returns `{"ok": false, "reason": "stale"}` when the file has changed since the agent last read it. Early in the project this felt like friction. It is actually one of the most important safety properties in the system:

- Prevents agents from clobbering each other's writes
- Forces a read-before-write discipline
- Makes concurrent access to shared files safe

Agents that fight this pattern (by blindly retrying) will corrupt state. Agents that respect it (read → write → verify) are reliable collaborators.

---

## Part 2 — Foundational Guidelines

### 2.1 Three-Layer Document Hierarchy

Every sandbox should have exactly three tiers of documentation:

| Tier | Content | Read when |
|---|---|---|
| **Core** | AGENTS.md, WORKFLOW.md, RECOVERY.md, VALIDATION.md | Every task |
| **SOPs** | Per-agent operational playbooks in `/data/sops/<agent>.md` | On heartbeat wake with no stimuli |
| **Reference** | Protocol library, schemas, specs | When the task requires it |

Agents should not need to read the reference library to handle routine tasks. If they do, something belongs in the core tier.

### 2.2 The Minimal Core

The core documents should be as small as possible while covering:

1. **Identity and roles** — who each agent is, what they own
2. **The working loop** — how to wake, read state, act, write state, sleep
3. **The communication contract** — who talks to whom, when, in what channel
4. **Error and blocker handling** — the two-strike rule, escalation chain
5. **The compliance gate** — what `validate/run` checks and when to call it

Everything else is reference. If you find yourself adding a sixth item to this list, ask whether it belongs in an SOP instead.

### 2.3 CONTEXT.md as Program Counter

Each agent's CONTEXT.md is not a status update for humans — it is the agent's program counter. It must be writable in a single atomic operation and readable in full within one tool call.

**Minimum viable schema:**
```
Active Project: <name or None>
Current Task: <description, awaiting-direction, or None>

## Mini Checklist
- [ ] item

Blockers: None

## Recent Updates
- YYYY-MM-DD: entry (max 5)
```

Rules:
- `Active Project` and `Current Task` must always be set — even to `None`
- `Recent Updates` is capped at 5 entries (cap enforced by the `context/compact` tool)
- `Blockers` is written as `None` when clear — never omitted
- The `CONTEXT_STALE` validator fires when all checklist items are `[x]` — this is the signal to close the task and reset

### 2.4 Hard Escalation Boundaries

Some decisions must always go to the human principal (@architect). Agents should not reason their way around these:

1. **Scope expansion** — task grows beyond the stated project
2. **Irreversible operations** — deleting projects, archiving active work, dropping ledger entries
3. **External communications** — anything that leaves the sandbox (Slack, email, webhooks)
4. **Unexpected resource cost** — LLM calls or fetches at unusual scale
5. **No protocol coverage** — genuinely novel situation with no applicable rule

These are not optional escalation points — they are hard stops. An agent that proceeds past them without authorisation is operating outside its mandate.

### 2.5 The Two-Strike Rule

When an agent hits an error:

- **Strike 1:** Diagnose. Read the error, adjust the approach, retry once with a different strategy.
- **Strike 2:** Escalate. Write the blocker to CONTEXT.md, DM @ivy (or @architect if @ivy is the problem), and stop acting on the broken path.

The failure mode this prevents: an agent that retries the same failing operation 10 times across 10 ticks, producing nothing and filling the room with noise.

---

## Part 3 — How to Structure a Self-Organising System

### 3.1 Separation of Concerns Between Agents

Each agent should own a distinct capability surface. Overlap creates coordination overhead and ambiguity about who acts first. The Ivy model:

| Agent | Owns | Does not own |
|---|---|---|
| @ivy | Room coordination, task sequencing, ledger updates, final synthesis | Implementation, file authoring, fetch jobs |
| @nova | Implementation, file authoring, data fetch, technical research | Room decisions, task sequencing |
| @sentinel | Compliance gate, integrity validation, anomaly alerting | Task work, room participation |

When an agent is unsure whether a task is theirs, the answer is usually: check your SOP. If it is not in your SOP, it belongs to someone else.

### 3.2 The Handoff Protocol

Inter-agent work transfer should follow a consistent pattern:

1. **Sender** completes the unit of work, writes the output file, DMs the receiver with a structured handoff (what was done, where the file is, what is expected next)
2. **Receiver** acknowledges, reads the file, acts, updates their CONTEXT.md
3. **Sender** resets their checklist and heartbeat

A handoff is not complete until the receiver has acknowledged. The sender should not move on to unrelated work until the handoff is confirmed.

### 3.3 The Heartbeat as Self-Management

Heartbeat is the agent's autonomy dial. The pattern:

- **Active task (60s):** Agent is mid-work, needs frequent wakes to make progress
- **Standby (300s):** Task blocked or awaiting handoff, checking in periodically
- **Idle (null/off):** Nothing to do, wakeOn handles all wakes

Agents should set their heartbeat to match their workload — not leave it at 60s when idle. An agent pinging at 60s with nothing to do consumes LLM calls for no purpose.

The SOP Protocol Anchor Rule: **on a heartbeat wake with no stimuli, read your SOP first**. This prevents agents from drifting into ad-hoc work that wasn't requested.

### 3.4 The Living Script Pattern

For tasks that span multiple context windows, agents use task files rather than trying to hold state in working memory:

```
/home/<agent>/tasks/<slug>.md
```

Structure:
```markdown
# Task: <title>
Status: active | blocked | complete
Last updated: YYYY-MM-DD HH:MM UTC

## Goal
One sentence.

## Steps
- [x] Completed step
- [ ] Current step — pick up here
- [ ] Future step

## Notes
Discoveries, edge cases, decisions made.
```

On each wake, the agent reads the task file first. The `- [ ] Current step — pick up here` line is the program counter. This pattern is robust to context window flushes, model restarts, and multi-day tasks.

### 3.5 The Knowledge Migration Rule

Before closing a project, the agent should migrate durable findings to `/data/library/`. The distinction:

- **Project files** (`/data/projects/<name>/`): working state, temporary artefacts, task ledgers. Can be archived.
- **Library** (`/data/library/`): reusable knowledge, patterns, reference material. Permanent.

Failing to migrate means knowledge is siloed in project directories and becomes inaccessible when the project is archived. The library is the sandbox's long-term memory.

### 3.6 The Validate-Then-Write Pattern

Any batch operation that modifies multiple files should end with `validate/gate` as the last operation. If validation fails, `batch/apply` rolls back all file writes atomically.

```
batch/apply:
  1. text/write  → file A
  2. text/write  → file B
  3. index/write → register both
  4. validate/gate → throw on violations (triggers rollback)
```

This prevents partial writes where some files are updated but the index is not, or where a write produces a compliance violation that the agent does not notice until the next tick.

---

## Part 4 — Observability Patterns

### 4.1 What Healthy Looks Like in the Log

A healthy system produces this pattern:

```
Ivy thinking
Ivy think done          ← fast (< 20s)
[@ivy] ...              ← meaningful output
Nova thinking
Nova think done
validate/run → pass     ← after any significant write
```

Warning signs:
- `think error` + `re-queued` appearing more than once per minute (infra issue)
- `text/write → stale` appearing repeatedly without a `text/read` in between (agent not re-reading before retry)
- A single agent producing 5+ consecutive ticks with no room output (stuck loop)
- `CONTEXT_STALE` not self-resolving within 1–2 ticks (agent not running cleanup path)

### 4.2 Sentinel as Ground Truth

@sentinel's `validate/run` over the full sandbox (`55 dirs, 218 files`) on every scheduled gate is the authoritative health signal. A clean pass means:

- Every directory has an index.md
- Every index.md entry points to a real file
- Every file referenced in an index exists
- Every CONTEXT.md has the required fields
- No CONTEXT.md is stale

If sentinel reports a violation, it DMs @ivy and @architect with the exact path and rule. The agent whose file is in violation should self-resolve within 1–2 ticks. If it does not, that is a two-strike situation.

---

## Part 5 — Anti-Patterns to Avoid

| Anti-pattern | What happens | Fix |
|---|---|---|
| Mandatory protocol coverage check on every task | Agents halt on ambiguity, produce gap warnings instead of work | Move to reference tier; trust agent judgment |
| CONTEXT.md with too many fields | Schema drift between docs and validator; false positives everywhere | Keep to 5 fields; validator is source of truth |
| No formal blocker mechanism | Agents spin on blocked tasks, filling room with noise | CONTEXT.md `Blockers:` field + two-strike escalation |
| Heartbeat left at 60s when idle | Unnecessary LLM calls, log noise | Agents reset heartbeat to null when task complete |
| Announce-before-edit rules | Doubles tick count for every file operation; agents narrate instead of doing | Remove; trust the note system for audit trail |
| `text/write` without reading first | Stale write failures; agent retries blind | Always `text/read` before `text/write` on shared files |
| Agents owning overlapping task surfaces | Coordination conflicts, duplicate work | Hard role boundaries enforced by SOPs |
| Accumulating > 5 Recent Updates | CONTEXT.md grows unbounded; older entries pollute context | `context/compact` on close of each task |

---

## Summary

The key insight across all of this: **LLM agents do not fail because they are not smart enough — they fail because their environment does not give them reliable footholds**. A well-designed sandbox gives agents:

- A stable, small set of rules they can actually internalise
- Filesystem state they can read and trust
- A formal mechanism for every situation they will encounter (blocker, handoff, escalation, close)
- Validation that catches drift before it compounds

When those footholds are in place, agents self-organise naturally. They coordinate handoffs without being told to, self-correct compliance violations, park blockers cleanly, and migrate knowledge at project close. The operator's job becomes direction and review, not rescue.

---

_Last updated: 2026-03-05_
_Author: Claude Code / @architect_
