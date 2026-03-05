# Workflow

How work is planned, executed, reviewed, and closed. This is the single operational reference.

---

## Protocol Anchor Rule

**On any heartbeat wake with no stimuli: read your SOP before doing anything else.**

Memory is lost between context windows. Your SOP re-anchors you. Only after reading it should you check CONTEXT.md and decide what to do.

---

## Before Starting Any Task

1. Read your SOP (`/data/sops/<you>.md`).
2. Read the relevant files — understand what already exists before changing anything.
3. Check the task's autonomy level: `supervised` (default) or `delegated`. See `AGENTS.md`.
4. Set `Active Project` and `Current Task` in your `CONTEXT.md`.
5. For any task touching more than one file or spanning more than one tick: write a task file at `/home/<agent>/tasks/<slug>.md` before your first edit. See the template at `/data/templates/task.md`. This is your program counter — it survives context flushes. The CONTEXT.md Mini Checklist is the summary; the task file is the detail.

**`supervised` mode:** Confirm scope with @lead (or @principal if you are @lead) before proceeding.
**`delegated` mode:** Proceed directly after one-time scope confirmation.

---

## Executing Changes

**Surgical first.** Use `text/replace` or `text/patch` for targeted changes. Use `text/write` only for new files or full rewrites.

**Atomic for multi-file changes.** Wrap related edits in `batch/apply`. If one step fails, all others roll back. End significant batches with `validate/gate` to catch violations and trigger rollback on failure.

**Keep indexes current.** When you add, move, or delete a file: update the parent `index.md` in the same operation. Never defer. Use `index/write` to create and register a new file atomically.

**Read before every write.** Every time. Without exception. If you get a `stale` response on a write, the file changed since you last read it. Re-read, then re-write.

**After each step in a multi-step task:** mark it `[x]` in your task file and update the `[/]` marker immediately. Do not batch updates to the end — an outdated task file is useless after a restart.

---

## Validate Before Closing

Run `validate/run` on the affected path before any handoff or task close. Fix all violations. A deliverable with outstanding violations is not complete.

```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/data/projects/<name>" } }] }
```

See `VALIDATION.md` for all rule IDs and fix hints.

---

## Coordination and Handoffs

**@lead → @impl task assignment.** One DM with:
- `Task:` what to do
- `Done criteria:` how you will know it is complete
- `Target paths:` which files/directories to touch
- `Autonomy:` supervised or delegated

**@impl → @lead handoff.** One DM with:
- What was done
- Path to the deliverable
- Validate/run result (must be pass)
- Any open questions

No check-ins between these two messages. No progress updates. The room stays quiet until the result exists. If something blocks @impl mid-task, that is a blocker escalation, not a check-in — see `RECOVERY.md`.

**Review gate (mandatory for all @impl deliverables):**

| Round | @lead action |
|---|---|
| Review | **Accept** → proceed to close. **Reject** → numbered, specific, actionable change requests. |
| @impl revises | Addresses every numbered point. States what was changed and how. |
| Repeat | Maximum 2 rejection rounds between @lead and @impl. |
| Round limit | @lead DMs @principal with deliverable, outstanding objections, @impl's last response. |
| After @principal input | @impl makes one final revision. @lead reviews once more. Final. |

---

## Communication Discipline

**Channel selection:**
- `speak` (public) — completed deliverables, status reports, questions for @principal. Not a work log.
- `dm` — coordination, handoffs, blockers, review feedback.
- `note` — everything else: reasoning, tool results, interim state.

**Do not narrate tool work publicly.** File writes, validation runs, batch operations — these are notes, not announcements.

**No acknowledgment-only messages.** Reply only when you have substance.

**On a heartbeat tick with no new stimuli:** prefer tool work or silence over commentary.

---

## Closing a Task

1. Confirm `validate/run` passes on the affected path.
2. Confirm the Mini Checklist in CONTEXT.md is complete.
3. Mark the task as completed in the project `tasks.md`.
4. Archive or delete the task file.
5. **Migrate knowledge.** Before closing a project, identify any findings, patterns, or reference material with durable value and move them to `/data/library/`. Projects are transient; the library is permanent. Knowledge left only in a project directory is knowledge that will be lost when the project is archived.
6. Clear the Mini Checklist. Set `Active Project: None` and `Current Task: None` if no work remains.
7. Post one brief completion notice stating what was delivered and where.
8. **Stop.** The next step is @principal's decision.

---

## Heartbeat Self-Management

| State | heartbeatMs |
|---|---|
| Active work | `60000` (1 min) |
| Awaiting direction / blocked | `300000` (5 min) |
| No active project, intake empty | `null` (off) |
| Locked by @principal | Do not self-adjust — record lock in CONTEXT.md |

Change heartbeat in the same tick as the event that triggers it. @principal releases a lock by saying "unlock heartbeat", "resume self-managing", or by setting a new value.

---

## Home Directory

Your home at `/home/<agent>/` is your private workspace.

**Required files:** `index.md`, `CONTEXT.md`, `AGENTS.md`.

**Standard layout:**
```
/home/<agent>/
├── index.md
├── CONTEXT.md
├── AGENTS.md
└── tasks/          ← living script task files
    └── index.md
```

Add subdirectories only when a cluster of related files warrants it. Every subdirectory needs an `index.md`. Keep names lowercase-kebab-case.

**What goes where:**
- Working drafts, personal research → `/home/<agent>/`
- Shared deliverables, cross-agent artifacts → `/data/projects/`
- Scratch / throwaway → `/tmp/`

Self-validate when switching context:
```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/home/<agent>" } }] }
```

---

## CONTEXT.md Format

```
Active Project: <name or None>
Current Task: <description, awaiting-direction, or None>

## Mini Checklist
- [ ] step
- [x] done step

Blockers: <None, or specific description>

## Recent Updates
- YYYY-MM-DD: entry (max 5, newest first)
```

- Do not store decisions, protocols, or reference material here.
- `Recent Updates` is capped at 5. Run `context/compact` on close.
- When `Active Project` is None, checklist must be empty.
- When `Current Task` is active, heartbeat should be 60s.
- When `awaiting-direction`, heartbeat should be 300s.
