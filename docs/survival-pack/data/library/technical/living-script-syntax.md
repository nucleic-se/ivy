# Living Script — Syntax Reference

A Living Script is the **Safety Soul** for a multi-step task: the artifact that survives a context flush and lets an agent reboot into a known state. Without it, a context reset means starting over from scratch. With it, `script/read_step` orients the agent in one call regardless of how long ago the task started.

**Rule: if a task will take more than one tick, use a Living Script. No judgment call.**

The `script/*` tools read and mutate it — do not edit it manually while a script is active.

## File Format

```
# Script: <title>

Owner: @<agent>
Goal: <one sentence — what does done look like?>
Created: YYYY-MM-DD
Status: active

## Acceptance Criteria
- [ ] <verifiable criterion>

## Steps
- [/] S1: <step title>
- [ ] S2: <step title>
- [ ] S3: <step title>

## State
Current: S1
Attempts: 0
Scratchpad:

## Handoff Log

```

## Step Markers

| Marker | Meaning |
|--------|---------|
| `[ ]` | Pending |
| `[/]` | Current (active pointer) |
| `[x]` | Done |
| `[!]` | Failed |

Exactly one step should carry `[/]` at any time. The `State.Current` field mirrors it.

## Step IDs

Steps are numbered `S1`, `S2`, `S3`, ... assigned at creation. Sub-steps use dot notation: `S2.1`, `S2.2`. IDs are stable — do not renumber steps after creation.

## State Section

- `Current` — ID of the step currently in progress. Set to `(complete)` when all steps are done.
- `Attempts` — cumulative failure count for the current step. Resets to 0 on `script/advance`.
- `Scratchpad` — single-line free text. Use for mid-step notes, URLs, or context surviving a context flush. Max 1 KB. Updated via `script/set_state`.

## Handoff Log

Append-only record of step completions and failures. Each entry:

```
### S2
Result: success | partial | fail
Completed: YYYY-MM-DD HH:MM UTC
Summary: What was accomplished or why it failed.
```

`script/read_step` returns the most recent log entry for the requested step — use it to orient after a context flush without reading the whole file.

## Tools

| Tool | Purpose |
|------|---------|
| `script/create { path, title, goal, steps[], owner? }` | Scaffold new script, register in parent index.md, set S1 as current |
| `script/list { dir, status? }` | Discover scripts in a directory (default: active only) |
| `script/status { path }` | Compact overview: step list + markers + state. Token-efficient. |
| `script/read_step { path, step? }` | Read current (or named) step + State + last handoff entry |
| `script/advance { path, summary, result? }` | Mark current step `[x]`, move pointer to next, append handoff log |
| `script/fail_step { path, reason }` | Increment Attempts, append failure log entry |
| `script/set_state { path, scratchpad }` | Update Scratchpad without advancing |

## Escalation

`script/fail_step` returns `{ escalate: true }` when `Attempts` reaches 3. On escalation, DM @architect with a blocker report per WORKFLOW.md Recovery section.

## Workflow Pattern

```
script/create   →   script/read_step (orient)
                →   [do the work]
                →   script/set_state (mid-step notes)
                →   script/advance (step done)
                →   repeat until complete: true
```

After a context flush: `script/list` to rediscover the path, `script/read_step` to reorient, continue.

## Naming Convention

Store scripts in `/home/<agent>/tasks/`. Filename: `<slug>.md` (kebab-case, no spaces). Record the path in CONTEXT.md Mini Checklist so it survives a context flush.
