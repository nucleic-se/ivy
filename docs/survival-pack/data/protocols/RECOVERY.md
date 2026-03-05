# Recovery

How agents respond to errors, blockers, and tool failures.

**Core principle: errors must not be silenced.** Every unresolved error propagates up the escalation chain until resolved.

---

## The Two-Strike Rule

**Strike one — a tool call fails.**
- Read the full error message carefully.
- Attempt exactly one alternative: check the parent directory with `text/tree`, correct an argument, use a different tool that achieves the same goal.
- If resolved: continue.

**Strike two — the alternative also fails, or no viable alternative exists.**
- **Stop.** Do not make a third attempt.
- Write the blocker to your `CONTEXT.md` (survives restarts; notes do not).
- DM the next level in the escalation chain.
- Reduce heartbeat to `300000` (standby) while awaiting resolution.

**Never retry the same failing tool call with identical arguments.** If the same call failed, the same call will fail again. Something in the world needs to change before retrying is useful.

---

## Escalation Chain

| Level | Actor | Trigger | Action |
|---|---|---|---|
| 0 | Self | First failure | One alternative attempt. If resolved, continue. |
| 1 | @lead | Second failure, or no alternative | DM @lead with blocker report. Stop retrying. |
| 2 | @principal | @lead cannot resolve, or @lead is blocked | @lead DMs @principal with full context. |

@impl escalates to @lead. @lead escalates to @principal. @principal is the terminal authority.

---

## Blocker Format

Use this exact format in both your `CONTEXT.md` update and your escalation DM:

```
[BLOCKER] <what you were trying to do>
Tried:       <tool> with <args summary> → <error message>
Alternative: <what you tried> → <error, or "none found">
Cannot proceed because: <one sentence reason>
Awaiting: @lead direction
```

"I am stuck" is not a valid escalation. The blocker format gives the recipient everything needed to act without asking follow-up questions.

---

## Error Visibility

- **Any tool failure** → log it in internal notes and in `CONTEXT.md Blockers`.
- **Two consecutive failures on the same operation** → escalate per chain; do not continue the task.
- **Discovered structural violations** (missing index entry, stale path, broken reference) → fix immediately if in scope. If out of scope: log in CONTEXT.md and DM @lead.

---

## Resuming After a Blocker Is Resolved

When @lead or @principal resolves a blocker and gives direction:

1. Re-read your CONTEXT.md to reconstruct state.
2. Read the task file to find your checkpoint.
3. Clear the Blockers field: `Blockers: None`.
4. Reset heartbeat to match current task state.
5. Continue from the `[/]` step in the task file.

---

## Hard Constraints

- **MUST NOT** retry the same failing tool call more than once with the same arguments.
- **MUST** write every persistent blocker to `CONTEXT.md` before the tick ends — notes alone do not survive restarts.
- **MUST** DM the next escalation level in the same tick that strike two is confirmed.
- **MUST NOT** resume blocked work until the escalation is explicitly resolved.
- **MUST** include the blocker format in every escalation DM.
