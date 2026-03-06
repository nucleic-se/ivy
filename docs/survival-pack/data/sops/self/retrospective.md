# SOP: Project Retrospective

**Owner:** @nova (executes); @ivy (reviews brief before library filing)
**Trigger:** After a project is closed and archived

This is a Living Script task. Create the script before reading any project files.

---

## Script Steps

**S1: Gather materials**
- Locate the archived project at `/data/archive/projects/<name>/`.
- Read: `tasks.md`, `logs/` directory listing, final `CONTEXT.md`, any research files.
- Record: what was the original goal? What was actually delivered?

**S2: Extract patterns**
Answer from the materials:
- What worked well? (tools, patterns, coordination)
- What failed or slowed things down? (errors, loops, unclear briefs, tool misuse)
- What would you do differently?
- Does anything suggest a change to WORKFLOW.md, a SOP, or AGENTS.md? **Flag only — do not edit.**

Write findings to `/tmp/retro-<slug>/findings.md`. Be factual; no post-hoc rationalisation.

**S3: Write retrospective brief**
Format:
```
# Retrospective: <project>
## What Was Delivered
## What Worked
## What Didn't
## Recommendations
```
Write to `/tmp/retro-<slug>/retro.md`.

**S4: File to library**
- `index/write { path: "/data/library/retrospectives/retro-<project>.md", content: ... }`
- Create `retrospectives/` domain and index if absent: `index/refresh { path: "/data/library/retrospectives" }`

**S5: Flag protocol changes (if any)**
- If S2 identified anything warranting a rule change: draft a PRP stub at `/data/foundation/proposals/PRP-NNN-<slug>.md`.
- **Do NOT edit AGENTS.md, SOPs, or WORKFLOW.md directly. @architect approves all protocol changes.**
- If no protocol issues found: skip this step.

**S6: Close**
- `validate/gate { path: "/data/library/retrospectives" }`
- Reset CONTEXT.md.
- DM @ivy: brief path, one key finding, list of any PRPs raised (or "none").

---

## Failure handling

- Archive incomplete (missing logs) → work with what exists; note gaps in the brief.
- No meaningful lessons found → file a one-paragraph brief noting that. Still close the loop.
- `validate/gate` fails → fix before DMing @ivy.
