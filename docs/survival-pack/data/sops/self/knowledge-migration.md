# SOP: Knowledge Migration

**Owner:** @nova
**Trigger:** Quarterly schedule (`knowledge_migration_quarterly`) or when archive grows large

This is a Living Script task. The archive may contain many projects — pace the work across steps to avoid token pressure.

---

## Curation standard

The library is curated, not archived. File a brief only if you would consult it in a future task. When in doubt, leave it out. Execution logs (tool calls, path writes) have no library value — skip them.

---

## Script Steps

**S1: Survey archive**
- `text/tree { path: "/data/archive/projects" }` — list all archived projects.
- For each project: note whether it has `research/`, `logs/`, or a non-trivial `tasks.md`.
- Write candidate list to `/tmp/kmig-<date>/candidates.md`:
  `<project> | <dirs with potential> | high/medium/low value`

**S2: Screen candidates**
- For each high/medium candidate: read the project's final `CONTEXT.md` and `tasks.md`.
- Keep only items containing: findings, patterns, reference data, or specs useful in future work.
- Reduce to a short extraction list. Document skipped projects and why.

**S3: Extract**
- For each item on the extraction list:
  - Read the source. Write a curated brief to `/tmp/kmig-<date>/extracts/<project>-<topic>.md`.
  - Format: `## Source`, `## Key Findings`, `## Applicability`.
  - Distil — do not copy verbatim log blocks.

**S4: File to library**
- For each extract: determine domain, create if absent (`index/refresh`).
- File: `index/write { path: "/data/library/<domain>/brief-<NNN>-<project>-<topic>.md", content: ... }`
- Batch index updates where possible.

**S5: Close**
- `validate/gate { path: "/data/library" }`
- Clear `/tmp/kmig-<date>/`.
- Reset CONTEXT.md.
- DM @ivy: N briefs filed, domains updated, projects with nothing worth extracting (list them).

---

## Failure handling

- Project archive unreadable → skip, note in DM to @ivy.
- Candidate list is empty → file a one-line note and close. Valid outcome — means the archive was already clean.
- `validate/gate` fails → fix before DMing @ivy.
