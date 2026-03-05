# Workflow

How work is planned, executed, reviewed, and closed. This is the single operational reference — including recovery rules, validation rule IDs, and communication discipline.

---

## Before Starting Any Task

1. Read your SOP (`/data/sops/<you>.md`). On a heartbeat wake with no stimuli, read your SOP before doing anything else — this re-anchors you after a context flush.
2. Read the relevant files — understand what already exists before changing anything.
3. Check the task's autonomy level: `supervised` (default) or `delegated`. See `AGENTS.md`.
4. Set `Active Project` and `Current Task` in your `CONTEXT.md`.
5. For any task touching more than one file or spanning more than one tick: write a Mini Checklist in your `CONTEXT.md` before your first edit.

**`supervised` mode:** Confirm scope with @lead (or @principal if you are @lead) before proceeding.
**`delegated` mode:** Proceed directly after one-time scope confirmation.

---

## Executing Changes

**Surgical first.** Use `text/replace` or `text/patch` for targeted changes. Use `text/write` only for new files or full rewrites.

**Atomic for multi-file changes.** Wrap related edits in `batch/apply`. If one step fails, all others roll back. End significant batches with `validate/gate` to catch violations and trigger rollback on failure.

**Keep indexes current.** When you add, move, or delete a file: update the parent `index.md` in the same operation. Never defer. Use `index/write` to create and register a new file atomically.

**Read before every write.** Every time. Without exception. If you get a `stale` response on a write, the file changed since you last read it. Re-read, then re-write.

---

## Tracking Complex Work

For any task spanning multiple ticks or involving 3+ sequential steps:

**Create a Living Script** at `/home/<agent>/tasks/<slug>.md` using `script/create`. This is your program counter — it survives context window flushes. The CONTEXT.md Mini Checklist is a summary; the task file is the detail.

```json
{ "tool": "script/create", "args": {
  "path": "/home/<agent>/tasks/<slug>.md",
  "title": "Task Title",
  "goal": "One sentence — what does done look like?",
  "steps": ["Define", "Execute", "Validate", "Close"]
}}
```

Working with a Living Script:
- `script/read_step` — read only the current step + state (token-efficient, use on every wake).
- `script/set_state` — record mid-step notes in the scratchpad without advancing.
- `script/advance { path, summary }` — mark step done, move pointer to next, append handoff log. **`summary` is required** — one or two sentences describing what was accomplished.
- `script/fail_step { path, reason }` — record a failure; increments attempt counter. Returns `escalate: true` at 3 consecutive failures — DM @lead/@principal with a blocker report.
- `script/list { dir }` — list active scripts in a directory. Use this to rediscover a script path after a context flush.
- `script/status { path }` — compact step list with markers, no body content.

Rules:
- Write the goal and acceptance criteria (`script/create`) before touching any files.
- Record the script path in your CONTEXT.md Mini Checklist immediately after `script/create`.
- After completing a step: call `script/advance` immediately. Never batch log entries.
- On unexpected stop: call `script/set_state` to record exactly what the next action is.
- The final step must always be **Close**: run `validate/gate`, reset CONTEXT.md, DM @lead with the deliverable path.

---

## Recovery

**No loop is allowed to persist when it produces no useful output.**

**Strike one** — a tool call fails.
- Read the full error message carefully.
- Attempt exactly one alternative: check the parent directory with `text/tree`, correct an argument, use a different tool that achieves the same goal.
- If resolved: continue.

**Strike two** — the alternative also fails, or no viable alternative exists.
- **Stop.** Do not make a third attempt.
- Write the blocker to your `CONTEXT.md` (survives restarts; notes do not).
- DM the next level in the escalation chain in the same tick.
- Reduce heartbeat to `300000` (standby) while awaiting resolution.

**Escalation chain:** @impl → @lead → @principal (terminal authority).

**Blocker format** (use in both `CONTEXT.md` and the escalation DM):
```
[BLOCKER] <what you were trying to do>
Tried:       <tool> with <args summary> → <error message>
Alternative: <what you tried> → <error, or "none found">
Cannot proceed because: <one sentence reason>
Awaiting: @lead direction
```

**Hard constraints:**
- MUST NOT retry the same failing tool call more than once with the same arguments.
- MUST write every persistent blocker to `CONTEXT.md` before the tick ends.
- MUST DM the next escalation level in the same tick that strike two is confirmed.
- MUST NOT resume blocked work until the escalation is explicitly resolved.
- MUST include the blocker format in every escalation DM.

---

## Validation Rules

Run `validate/run { path: "/data/projects/<name>" }` before any handoff or close. Must be `pass`.

| Rule | Trigger | Fix |
|---|---|---|
| `INDEX_MISSING` | A directory has no `index.md` | Create `index.md` in the flagged directory |
| `MANIFEST_DEAD` | An `index.md` entry points to a file that does not exist | Remove or correct the broken link |
| `MANIFEST_UNDOC` | A file or directory exists but its name is absent from the parent `index.md` | Add the entry: `` `name` `` (backtick), `[name](link)`, or a glob like `` `*.json` `` |
| `BROKEN_REF` | A `.md` file (non-index) links to a non-existent target | Remove or correct the broken link |
| `CONTEXT_SCHEMA` | A `CONTEXT.md` is missing a required section | Add the missing section. Required: `Active Project`, `Current Task`, `Mini Checklist`, `Blockers`, `Recent Updates` |
| `CONTEXT_STALE` | `Active Project` is set but all Mini Checklist items are `[x]` | Clear the checklist; reset `Active Project` and `Current Task` to `None` |

Use `validate/gate` (not `validate/run`) as the final op in a `batch/apply` — it throws on violations, triggering rollback.

To exclude a directory from deep validation, add `validate: skip` on its own line in that directory's `index.md`. The directory itself is still checked by its parent. Use sparingly.

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

No check-ins between these two messages. No progress updates. The room stays quiet until the result exists. If something blocks @impl mid-task, that is a blocker escalation — follow the Recovery section above.

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

1. Run `validate/gate` on the affected path.
2. Reset CONTEXT.md: `Active Project: None`, `Current Task: None`, clear checklist.
3. Mark the task as completed in the project `tasks.md`.
4. Archive or delete the task file.
5. **Migrate knowledge.** Before closing a project, move any findings or reference material with durable value to `/data/library/`. Knowledge left only in a project directory is knowledge that will be lost when the project is archived.
6. Post one brief completion notice stating what was delivered and where. **Stop.**

---

## Heartbeat Self-Management

| State | heartbeatMs |
|---|---|
| Active work | `60000` (1 min) |
| Awaiting direction / blocked | `300000` (5 min) |
| No active project, intake empty | `null` (off) |
| Locked by @principal | Do not self-adjust — record lock in CONTEXT.md |

Change heartbeat in the same tick as the event that triggers it.

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

Mini Checklist:
  - [ ] step
  - [x] done step

Blockers: <None, or specific description>

Recent Updates: (max 5, newest first)
- <date>: <one line>
```

- `Recent Updates` is capped at 5. Prune the oldest when adding a new one.
- When `Active Project` is None, the checklist must be empty.
