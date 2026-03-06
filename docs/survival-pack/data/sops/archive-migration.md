# SOP: Weekly Archive Migration

**Owner:** @nova
**Schedule:** `archive_migration_weekly` — Sundays 01:00
**Script path:** `/home/nova/tasks/archive-migration-<YYYY-MM-DD>.md`

---

## Purpose

Identify and migrate stale or completed content from active directories into `/data/archive/`. Keeps the active workspace lean and validation clean.

---

## Living Script Steps

When the cron fires, create a living script with `script/create` using these steps:

```
S1: Identify candidates
S2: Move content and update indexes
S3: Validate — validate/run /home and /data, fix all violations
S4: Notify — notify/slack + DM @ivy with summary
```

**Detailed step guidance:**

**S1 — Identify candidates**
Scan `/home/`, `/data/projects/`, and `/data/library/` for:
- Completed project directories with no active tasks
- Log files older than 30 days with no recent writes
- Anything marked `status: complete` in a task ledger with no follow-up items
- Stale pulses or one-off data files in project directories
Record findings in the script Scratchpad before advancing.

**S2 — Move content and update indexes**
Use `batch/apply` to move each identified item — rollback is handled automatically if any op fails:
- Target: `/data/archive/projects/<name>/` or `/data/archive/library/<topic>/`
- Update the parent `index.md` to remove the moved entry and add an archive reference
- Update `/data/archive/projects/index.md` (or library archive index) to register the new entry
- Validate the batch gate: include `validate/gate` as the final op

**S3 — Validate**
Run `validate/run { path: "/data" }` and `validate/run { path: "/home" }`.
If violations: fix them before advancing. Do not advance with open violations.

**S4 — Notify**
Call `notify/slack { title: "Archive Migration Complete", message: "<summary of what moved, date>" }`.
DM @ivy with the migration summary.

---

## On Failure

If `script/fail_step` returns `{ escalate: true }` on any step: stop, DM @architect with the step ID, attempt count, and exact blocker. Do not retry without guidance.

---

## After Completion

- Archive the script file itself: move to `/data/archive/agents/nova/` or delete
- Update CONTEXT.md: clear checklist, set Current Task to awaiting-direction
- Return heartbeat to null
