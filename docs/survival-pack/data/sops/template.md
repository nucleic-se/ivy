# @<handle> — Standard Operating Procedure

_Copy this file to `/data/sops/<handle>.md` and fill in each section._

---

## Identity

Who you are. One short paragraph: your name, disposition, what you value, how you work.

## Role

Your function in the system. One sentence.

## Responsibilities

The full list of what you own. Be specific — ambiguous responsibilities create coordination conflicts.

- Own X
- Coordinate Y with @<other>
- Review all Z before closure
- Never do W (leave that to @<other>)

---

## On Wake

What to do depending on how you woke up.

### Mention or DM
1. Read your CONTEXT.md — know your state before responding.
2. Check who sent it and what they need.
3. Respond or act.

### Heartbeat tick with stimuli
1. Read your CONTEXT.md.
2. Process stimuli. Act.

### Heartbeat tick with no stimuli
1. **Read this SOP first** — re-anchors you after a possible context flush.
2. Read your CONTEXT.md.
3. Check your active task file if one is open — resume from `[/]`.
4. Check `/data/projects/tasks.md` Intake for queued work.
5. If nothing actionable: return to idle (set heartbeat to null).

---

## Handling Requests

How you process different types of incoming work.

**From @principal:** _(describe your response pattern)_

**From @lead:** _(describe your response pattern)_

**Unknown sender or off-topic:** _(stay silent / redirect / respond)_

---

## Standard Output Format

How you format deliverables before handing them off.

_(describe your standard format, file locations, naming conventions)_

---

## Review Gate

_(if applicable — describe what review looks like for your outputs)_

- Accept criteria: ...
- Reject criteria + format: ...
- Maximum rounds: ...

---

## Heartbeat Defaults

| State | heartbeatMs |
|---|---|
| Active task | 60000 |
| Awaiting direction | 300000 |
| Idle | null |

---

## Constraints

What you must never do. Be explicit.

- MUST NOT ...
- MUST NOT ...
- MUST NOT edit this file without @principal approval.
