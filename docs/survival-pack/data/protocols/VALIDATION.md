# Validation

How to use `validate/run` and `validate/gate`, and what each rule means.

---

## When to Run

- After any batch of file operations (create, move, delete)
- Before submitting a deliverable for review
- Before closing any task
- When switching project context
- Any time the sandbox state feels uncertain

Running validation is cheap. Outstanding violations compound. Run it often.

---

## How to Run

**Check a path:**
```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/data/projects/<name>" } }] }
```

**Check your home:**
```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/home/<agent>" } }] }
```

**Check the full sandbox:**
```json
{ "calls": [{ "tool": "validate/run", "args": { "path": "/" } }] }
```

**Gate (throws on failure — use as last step in `batch/apply` for auto-rollback):**
```json
{ "tool": "validate/gate", "args": { "path": "/data/projects/<name>" } }
```

**Ask @gate directly:**
```
@gate please validate /data/projects/<name>
```

---

## Rule IDs

| Rule | Trigger | Fix |
|---|---|---|
| `INDEX_MISSING` | A directory has no `index.md` | Create `index.md` in the flagged directory |
| `MANIFEST_DEAD` | An `index.md` entry points to a file that does not exist | Remove or correct the broken link |
| `MANIFEST_UNDOC` | A file or directory exists but its name is absent from the parent `index.md` | Add the entry: `` `name` `` (backtick), `[name](link)`, or a glob like `` `*.json` `` |
| `BROKEN_REF` | A `.md` file (non-index) links to a non-existent target | Remove or correct the broken link |
| `CONTEXT_SCHEMA` | A `CONTEXT.md` is missing a required section | Add the missing section. Required: `Active Project`, `Current Task`, `Mini Checklist`, `Blockers`, `Recent Updates` |
| `CONTEXT_STALE` | `Active Project` is set but all Mini Checklist items are `[x]` | Clear the checklist; reset `Active Project` and `Current Task` to `None` |

---

## Output Format

```json
{
  "status": "pass | fail",
  "violations": [
    { "rule": "RULE_ID", "path": "/agent/path/to/file", "hint": "one-line fix hint" }
  ],
  "summary": {
    "directories_checked": 12,
    "files_checked": 34,
    "violations": 2
  }
}
```

`status` is `"pass"` if and only if `violations` is empty. Every violation has an exact path and a one-line fix hint. No narrative, no opinions.

---

## @gate Routing

| Result | @gate action |
|---|---|
| `pass` | Reply: `✓ pass — 0 violations at <path>.` |
| `fail` | Reply with violations list. DM @lead with the same list. |
| `fail` (same path + same count as last report) | Reply in-channel only. Do not re-DM @lead. |
| Tool error | DM @principal with raw error. |

---

## Opt-Out

To exclude a directory from deep validation (e.g. a large archive), add this on its own line in that directory's `index.md`:

```
validate: skip
```

The directory itself is still checked by its parent for `INDEX_MISSING` and `MANIFEST_UNDOC`. Only its children are excluded from traversal. Use sparingly.

---

## Hard Constraints

- **MUST NOT** close a task without a passing `validate/run` output on record.
- **MUST NOT** submit to @lead review without a passing `validate/run`.
- **MUST NOT** dispute @gate output — if unexpected, re-run and investigate; do not argue.
