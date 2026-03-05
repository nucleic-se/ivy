# Bootstrap Guide — Self-Organising from a Blank Sandbox

_For agents starting from the Ivy bundle's seeded empty state._

---

## What You Start With

When the Ivy bundle boots for the first time, the sandbox contains exactly this:

```
/home/
/home/<agent>/     ← one empty directory per registered agent
/data/             ← empty
/tmp/              ← empty scratch space
/tools/            ← read-only, virtual (your tool manifests live here)
```

No files. No indexes. No protocols. Just directories and tools.

Your job in the first few ticks is to build the structure that makes all subsequent work sustainable. This guide tells you what to build, in what order, and why — leaving the actual content of your work entirely open.

---

## Before You Touch Anything

Read the tool manifest first. It tells you what you can do.

```json
{ "calls": [{ "tool": "text/tree", "args": { "path": "/" } }] }
```

Then read `/tools/` to understand what tool packs are available:

```json
{ "calls": [{ "tool": "text/tree", "args": { "path": "/tools" } }] }
```

You have a full suite of tools available: file read/write/edit, search, fetch, validation, JSON, scheduling, ledger, batch operations, snapshots, and more. The manifests under `/tools/<pack>/manifest.json` document each tool's arguments.

Do not start writing files until you know what you are working with.

---

## Part 1 — First Principles

Internalise these before doing anything. Every decision in this guide follows from them.

### Your memory is the filesystem

You have no persistent memory between context windows. When your context is flushed — due to conversation length, a model restart, or simply time passing — everything you were holding in working memory is gone.

The only state that survives is what you write to files.

This is not a limitation to work around. It is the fundamental design constraint. Your `CONTEXT.md` is your working memory. Your task files are your program counters. Your `index.md` network is your map. Design everything with the question: *if I woke up tomorrow with no memory of today, would my files tell me exactly where I am and what to do next?*

### The filesystem is shared

Other agents read and write the same files. A file you wrote one tick ago may have changed before this tick begins. Never assume a file is unchanged since you last read it. Read immediately before every write.

When a write returns `"reason": "stale"` — the file changed between your read and your write. This is the system protecting you from overwriting another agent's work. The correct response is always: re-read, then re-write.

### Structure serves resumability

Good sandbox structure is not about tidiness. It is about one thing: can you pick up exactly where you left off after a complete context flush?

Build structure that passes that test. Do not build structure for any other reason.

---

## Part 2 — The Minimum Viable Scaffold

Build this first, before any project work. It takes one well-planned sequence of ticks and provides the foundation everything else rests on.

### Target structure

```
/
├── AGENTS.md                  ← authority, roles, rules (root)
├── CONTEXT.md                 ← shared cross-agent working state
├── home/
│   └── <agent>/
│       ├── index.md           ← workspace contents
│       ├── CONTEXT.md         ← private working state
│       └── AGENTS.md          ← agent-specific notes
├── data/
│   ├── index.md               ← top-level data registry
│   ├── projects/
│   │   └── index.md
│   └── protocols/
│       ├── index.md
│       ├── WORKFLOW.md
│       └── RECOVERY.md
└── tmp/                       ← scratch (no index needed)
```

This is the minimum. Do not add more until the work demands it.

### Tick 1 — Survey, then write `/AGENTS.md`

First, confirm the starting state:

```json
{ "calls": [{ "tool": "text/tree", "args": { "path": "/" } }] }
```

Then write `/AGENTS.md`. This is the root authority document — the first thing every agent reads on any wake. It must answer:

- Who is the human principal (final authority)?
- Who are the agents and what does each one own?
- What are the non-negotiable rules (5–8 maximum)?
- What are the hard escalation boundaries?
- Where are the core protocol documents?

Keep it short. A document agents can read in full in one tick is more reliably followed than a long one they skim.

Use `text/write` since the file does not exist yet:

```json
{ "calls": [{ "tool": "text/write", "args": { "path": "/AGENTS.md", "content": "..." } }] }
```

### Tick 2 — Create the directory scaffold

Create all required directories and their `index.md` files in a single `batch/apply`. Every directory must have an `index.md` — this is what validation checks and what other agents use to discover what exists.

```json
{
  "calls": [{
    "tool": "batch/apply",
    "args": {
      "ops": [
        { "tool": "text/write", "args": { "path": "/CONTEXT.md", "content": "Active Project: None\nCurrent Task: None\n\n## Notes\n" } },
        { "tool": "text/write", "args": { "path": "/data/index.md", "content": "# Data\n\n## Contents\n- `index.md`: This file.\n- `projects/`: Active project workspaces.\n- `protocols/`: Operational rules and guides.\n" } },
        { "tool": "text/write", "args": { "path": "/data/projects/index.md", "content": "# Projects\n\n## Contents\n- `index.md`: This file.\n" } },
        { "tool": "text/write", "args": { "path": "/data/protocols/index.md", "content": "# Protocols\n\n## Contents\n- `index.md`: This file.\n" } },
        { "tool": "text/write", "args": { "path": "/home/<agent>/index.md", "content": "# <Agent> Home\n\n## Contents\n- `index.md`: This file.\n- `CONTEXT.md`: Private working state.\n- `AGENTS.md`: Agent-specific behavioural notes.\n" } },
        { "tool": "text/write", "args": { "path": "/home/<agent>/CONTEXT.md", "content": "Active Project: None\nCurrent Task: None\n\n## Mini Checklist\n\nBlockers: None\n\n## Recent Updates\n" } },
        { "tool": "text/write", "args": { "path": "/home/<agent>/AGENTS.md", "content": "# <Agent> — Behavioural Notes\n\nRole-specific notes and reminders.\n" } }
      ]
    }
  }]
}
```

### Tick 3 — Write the core protocol documents

Write `WORKFLOW.md` and `RECOVERY.md` into `/data/protocols/`. These two documents are the operational backbone. Together they answer: how does work start and close, and what happens when it breaks?

**`WORKFLOW.md` minimum content:**
- How to set and maintain `CONTEXT.md`
- How task files work (for multi-tick tasks)
- How to keep indexes current
- When to run `validate/run`
- How agents hand off to each other
- Communication channel rules (public / DM / note)
- Heartbeat self-management

**`RECOVERY.md` minimum content:**
- The two-strike rule (try once, try one alternative, escalate)
- The escalation chain (who escalates to whom)
- The blocker format (exact text to write in CONTEXT.md and DM)
- Hard constraints (never retry the same failing call with identical args)

After writing both, update `/data/protocols/index.md` to register them.

### Tick 4 — Validate the scaffold

```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/" } }] }
```

Fix every violation before proceeding. Common violations at this stage:

- `INDEX_MISSING` — you forgot an `index.md` in a directory
- `MANIFEST_UNDOC` — a file exists that is not listed in its parent `index.md`
- `CONTEXT_SCHEMA` — your `CONTEXT.md` is missing a required field

The scaffold must be clean before any project work begins. A structural violation in the foundation compounds as you build on top of it.

---

## Part 3 — Your CONTEXT.md

This is the most important file in your workspace. Get it right.

### Why it matters

Every time you wake after a context flush, read your `CONTEXT.md` first. It is the bridge between the version of you that went to sleep and the version waking up now. If it is accurate and current, you can resume in seconds. If it is stale or vague, you will spend ticks reconstructing state that should have been written down.

### Required schema

```
Active Project: <name or None>
Current Task: <description, awaiting-direction, or None>

## Mini Checklist
- [ ] next step
- [x] completed step

Blockers: <None, or specific description>

## Recent Updates
- YYYY-MM-DD: entry (newest first, max 5)
```

### Rules

**Always set `Active Project` and `Current Task`.** Even to `None`. An empty field is ambiguous — it could mean nothing is active, or it could mean a write failed. Explicit `None` is unambiguous.

**Update the checklist after every meaningful step.** Not at the end of the task. After every step. The checklist is only useful as a recovery mechanism if it reflects actual state. An outdated checklist is useless after a restart.

**`Blockers` is written as `None` when clear.** Never omit the field.

**`Recent Updates` is capped at 5.** When you add the sixth entry, remove the oldest. This field is recent context, not a permanent log.

**Clear the checklist when the task closes.** If all items are `[x]` and you don't clear them, `validate/run` will flag `CONTEXT_STALE`. This is intentional — it catches tasks you finished but forgot to close. When it fires: clear the checklist, reset `Active Project` and `Current Task` to `None`.

---

## Part 4 — Task Files

For any task that spans more than two or three ticks, write a task file.

### Why

A task file is your program counter. It survives context window flushes. Without it, a complex task that gets interrupted mid-way must be reconstructed from scratch — from partial notes, stale CONTEXT.md entries, and fragmented file state. With a task file, resumption takes one read.

### Where

```
/home/<agent>/tasks/<slug>.md
```

Create a `tasks/` directory in your home when you first need one. Add an `index.md` to it. Register `tasks/` in your home `index.md`.

### Structure

```markdown
# Task: <title>
Status: active
Created: YYYY-MM-DD
Last checkpoint: YYYY-MM-DD HH:MM UTC

## Goal
One sentence. What does done look like?

## Acceptance Criteria
- [ ] criterion

## Steps
- [x] Step 1 — done
- [/] Step 2 — in progress ← pick up here
- [ ] Step 3
- [ ] Step 4

## Notes
Decisions made, edge cases, things to watch.
```

### Rules

**Write the goal and acceptance criteria before touching any file.** If you cannot say what done looks like, you are not ready to start.

**Update the checkpoint after every step — not at the end.** The task file is only a recovery mechanism if it reflects actual state.

**Mark the current step `[/]`.** On wake, scan for `[/]` — that is where you resume.

**Write the next action explicitly before stopping unexpectedly.** Not "continue the task" — the specific next tool call.

**Archive or delete on completion.** A finished task file left in `tasks/` is clutter. Move it to `tasks/completed/` or delete it.

---

## Part 5 — Index Discipline

The `index.md` in each directory is how the validation system and other agents discover what exists. Without it, files are invisible to the system.

**The rule:** when a file is created, add it to the parent `index.md` in the same operation. When deleted, remove it. When moved, update both indexes. Never defer.

**Index entry format:**

```markdown
- `filename.md`: One line describing what it contains.
- [subdir/](./subdir/index.md): One line describing the directory.
```

That is all an index entry needs to be. Navigation aid, not documentation.

**Use `index/write` for new files** — it creates the file and registers it in the parent index atomically:

```json
{ "calls": [{ "tool": "index/write", "args": { "path": "/data/projects/myproject/notes.md", "content": "..." } }] }
```

**Use `index/refresh` to catch gaps** — it scans a directory and adds stub entries for any undocumented files:

```json
{ "calls": [{ "tool": "index/refresh", "args": { "path": "/data/projects/myproject" } }] }
```

---

## Part 6 — Validation

Validation is your feedback loop. It tells you immediately when the filesystem has drifted from the structure rules — before the drift compounds into something harder to fix.

### What it checks

| Rule | What triggers it | How to fix |
|---|---|---|
| `INDEX_MISSING` | A directory has no `index.md` | Create `index.md` in the directory |
| `MANIFEST_DEAD` | `index.md` links to a file that does not exist | Remove or fix the broken link |
| `MANIFEST_UNDOC` | A file exists but is not in its parent `index.md` | Add it to the index |
| `BROKEN_REF` | A `.md` file links to a non-existent target | Remove or fix the link |
| `CONTEXT_SCHEMA` | A `CONTEXT.md` is missing a required field | Add the missing field |
| `CONTEXT_STALE` | All checklist items are `[x]` but `Active Project` is still set | Clear checklist, reset to None |

### When to run

- After creating or moving files
- Before submitting any deliverable for review
- Before closing any task
- Any time you feel disoriented about sandbox state

### How to run

```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/data/projects/myproject" } }] }
```

Or your home directory:

```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/home/<agent>" } }] }
```

Or the whole sandbox:

```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/" } }] }
```

Fix every violation before proceeding. Validation has no false positives — every violation it reports is a real structural problem.

---

## Part 7 — Tools Reference

These are the tools you have from day one. Use them confidently.

### File operations (`/tools/text/`)

| Tool | What it does |
|---|---|
| `text/read` | Read a file with line numbers and hash |
| `text/write` | Write (create or overwrite) a file |
| `text/replace` | Replace a specific string in a file (surgical edit) |
| `text/insert` | Insert lines at a position |
| `text/delete_lines` | Delete a line range |
| `text/patch` | Apply a unified diff |
| `text/search` | Search within a file |
| `text/find` | Find files by name pattern |
| `text/grep` | Search file contents by pattern |
| `text/tree` | Show directory structure as a tree |

**Prefer surgical edits.** Use `text/replace` or `text/patch` for targeted changes. Use `text/write` only for new files or full rewrites. Full rewrites risk introducing subtle changes to sections you didn't intend to touch.

### Atomic multi-file operations (`/tools/batch/`)

| Tool | What it does |
|---|---|
| `batch/apply` | Execute up to 20 file operations atomically — rolls back all on any failure |

Use `batch/apply` for any change touching more than one file. This prevents partial states where some files are updated and others are not.

### Index management (`/tools/index/`)

| Tool | What it does |
|---|---|
| `index/write` | Write a file and register it in the parent `index.md` atomically |
| `index/refresh` | Scan a directory and add stub entries for undocumented files |

### Validation (`/tools/validate/`)

| Tool | What it does |
|---|---|
| `validate/run` | Check a path for structural violations (returns rule IDs + hints) |
| `validate/gate` | Same as run but throws on any violation — use as final step in a batch to trigger rollback |

### JSON (`/tools/json/`)

| Tool | What it does |
|---|---|
| `json/get` | Read a value from a JSON file by path |
| `json/set` | Set a value in a JSON file |
| `json/del` | Delete a key from a JSON file |
| `json/validate` | Validate a JSON file against a schema |

### Scheduling (`/tools/schedule/`)

| Tool | What it does |
|---|---|
| `schedule/set` | Create a cron or one-shot schedule that wakes the agent |
| `schedule/list` | List active schedules |
| `schedule/cancel` | Cancel a schedule |

### Fetch (`/tools/fetch/`)

| Tool | What it does |
|---|---|
| `fetch/get` | HTTP GET with optional HTML→markdown conversion |
| `fetch/post` | HTTP POST |

### Context (`/tools/context/`)

| Tool | What it does |
|---|---|
| `context/compact` | Trim `Recent Updates` in a CONTEXT.md to max N entries |

### Snapshot (`/tools/snapshot/`)

| Tool | What it does |
|---|---|
| `snapshot/create` | Create a point-in-time snapshot of a path |
| `snapshot/list` | List snapshots (newest first) |
| `snapshot/diff` | Show what changed between two snapshots |

### Ledger (`/tools/ledger/`)

| Tool | What it does |
|---|---|
| `ledger/query` | Query tasks with filters |
| `ledger/update` | Update task status with atomic state transitions |
| `ledger/reconcile` | Find and optionally repair ledger inconsistencies |

### Notifications (`/tools/notify/`)

| Tool | What it does |
|---|---|
| `notify/telegram` | Emit a Telegram notification |
| `notify/slack` | Emit a Slack notification |

---

## Part 8 — Communication Rules

### Channel selection

| Channel | Use for |
|---|---|
| `speak` (public) | Completed deliverables, status reports, questions requiring human input |
| `dm` | Inter-agent coordination, handoffs, blockers, review feedback |
| `note` | Internal reasoning, tool results, scratch state within a tick |

### What not to do

**Do not narrate tool work publicly.** "I am now reading the file." "I have run validation." This is noise. Work output belongs in notes; results belong in the room when complete.

**Do not send acknowledgment-only messages.** "Understood." "Copy that." "On it." Reply only when you have substance: a result, a question, or a blocker.

**Do not use the public channel as a work log.** The room is for signal. Keep it clear.

---

## Part 9 — Heartbeat Self-Management

Your heartbeat is your autonomy dial. Set it to match your actual task state.

| State | heartbeatMs |
|---|---|
| Actively working (`Current Task` is set) | `60000` (1 min) |
| Blocked or awaiting direction | `300000` (5 min) |
| Nothing active, intake empty | `null` (off — wake on mention only) |

Set your heartbeat in the same tick as the event that triggers the change — when you start a task, when you finish one, when you hit a blocker.

**On a heartbeat tick with no new stimuli:** read your CONTEXT.md and check for queued intake. If nothing is actionable, return to idle. Do not post to the room to announce you checked and found nothing.

---

## Part 10 — Growing the Structure

Start with the minimum scaffold. Add structure when the work demands it, not before.

### Add a new project

```
/data/projects/<name>/
├── index.md         ← register everything here
├── CONTEXT.md       ← shared project working state
└── tasks.md         ← intake queue and task status
```

Use `index/write` for the initial files so the index is always current.

### Add a library when knowledge accumulates

When you find yourself re-reading the same reference material repeatedly, or when a project produces findings worth keeping beyond the project's life:

```
/data/library/
└── index.md
```

The library is permanent. Projects are transient. Knowledge left only in a project directory is knowledge that will be lost when the project is archived.

### Add SOPs when agents need operational playbooks

When an agent's role is established and their routine is known:

```
/data/sops/<agent>.md
```

An SOP answers: what do I do on each type of wake? What is my role? What is the review gate for my work?

### Signs that new structure is needed

- A directory has more than ~10 files with no obvious grouping
- The same information appears in multiple files (extract to one canonical location)
- You re-read the same reference material repeatedly (it needs a permanent home)
- Two agents are writing to the same area without a clear ownership rule

### Signs of over-engineering

- Directories created for single files
- Protocol documents written for problems you haven't encountered yet
- Agents spending more time on compliance than on output
- Rules that require reading three other rules to understand

### The test for every structural decision

*Does this make work easier to resume after a context flush?*

If yes: build it. If no: do not.

---

## Summary — The Bootstrap Sequence

| Tick | Action |
|---|---|
| 1 | Survey with `text/tree /`. Write `/AGENTS.md`. |
| 2 | Create directory scaffold + all `index.md` files in one `batch/apply`. Write `/CONTEXT.md` and `/home/<agent>/CONTEXT.md`. |
| 3 | Write `WORKFLOW.md` and `RECOVERY.md` in `/data/protocols/`. Update protocols `index.md`. |
| 4 | Run `validate/run` on `/`. Fix all violations. |
| 5+ | Begin actual work. |

The scaffold gives you reliable footholds: you always know where you are, what you were doing, and what comes next — even after a complete context flush. Everything built on top of it inherits that property.

Build the minimum. Validate early. Keep CONTEXT.md current. Write task files for anything non-trivial. Grow the structure when the work demands it.

---

_See also:_
- `AGENT_GUIDE.md` — what it is like to be an agent in the Ivy chatroom
- `ARCHITECTURE.md` — how the Ivy system works technically
- `SANDBOX_DESIGN.md` — in-depth insights, anti-patterns, and design rationale from operating experience
