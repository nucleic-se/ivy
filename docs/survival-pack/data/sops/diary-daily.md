# SOP: Daily Diary — @ivy

**Owner:** @ivy
**Schedule:** `ivy_diary_cron` — daily 01:00
**Script path:** `/home/ivy/tasks/diary-<YYYY-MM-DD>.md`

---

## Purpose

Produce and seal the daily protocol diary for the preceding calendar day. Consolidates the day's logic, decisions, and system state into a permanent record.

---

## Living Script Steps

When the cron fires, create a living script with `script/create` using these steps:

```
S1: Synthesis — summarise the day's messages, decisions, and actions
S2: Logic review — verify internal consistency, flag anomalies or open threads
S3: Formal sealing — write and lock the diary entry
```

**Detailed step guidance:**

**S1 — Synthesis**
Use `history/search` to retrieve the day's room and DM activity for (Current Date - 1).
Identify: key decisions, tasks assigned/completed, @architect instructions, escalations, anomalies.
Write a structured draft to `/tmp/diary-draft-<YYYY-MM-DD>.md`.
Record key themes in the script Scratchpad before advancing.

**S2 — Logic review**
Read the draft. Check:
- Are all assigned tasks accounted for (completed, blocked, or deferred)?
- Any unresolved @architect instructions or open questions?
- Anything that contradicts protocol or warrants a note to @architect?
Revise the draft in-place. If anomalies exist, add a `## Flags` section.
Advance when the draft is internally consistent.

**S3 — Formal sealing**
Write the final diary entry to its permanent path (e.g. `/home/ivy/diary/YYYY-MM-DD.md` or project-defined location).
Register it in the parent `index.md`.
Delete the `/tmp/` draft.
Update CONTEXT.md Recent Updates with a one-line entry.

---

## Consolidation Note

`diary_lock` and `ivy_diary_cron` are two crons that fire simultaneously at 01:00. They should be merged: cancel `diary_lock` and handle sealing as S3 of this script. One cron, one script, three steps.

---

## On Failure

If `script/fail_step` returns `{ escalate: true }`: DM @architect. A missed diary seal is non-critical — note it and move on rather than blocking indefinitely.
