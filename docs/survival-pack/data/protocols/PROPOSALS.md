# Proposals

How system change proposals (PRPs) work. Mandatory for any proposed change to protocols, runtime behaviour, or system architecture.

---

## Approval Authority

**Only @principal may approve, reject, or defer a proposal.**

No agent self-approval. No peer-approval. No implicit approval through implementation. @lead may draft proposals and flag gaps but may not approve. @impl may draft but may not approve.

---

## Lifecycle

```
Proposed → [reviewed by @principal] → Approved | Rejected | Deferred
Approved → [implementation directive from @principal] → Implementing → Implemented
```

| Status | Meaning |
|---|---|
| `Proposed` | Submitted, awaiting @principal review. No implementation work may begin. |
| `Rejected` | @principal declined. File retained for reference. |
| `Deferred` | @principal acknowledged but postponed. Stays in queue. |
| `Approved` | Accepted. Does not mean "implement now" — implementation requires a **separate explicit directive**. |
| `Implementing` | @principal has directed implementation. Active work in progress. |
| `Implemented` | Complete, reviewed, and closed. |

---

## Rules

1. No agent may change the `Status` field. Only @principal updates status.
2. `Approved` ≠ implement. A separate implementation directive is required.
3. Agents may draft proposals but must leave `Status: Proposed`.
4. No implementation work may begin until both: (a) @principal approves, and (b) @principal issues an implementation directive.
5. If @principal approves verbally in the room, @lead logs it in the proposal file before implementation begins — quoting the exact message.
6. Approved proposals awaiting implementation are tracked in `/data/foundation/proposals/index.md` under `## Approved Backlog`.

---

## File Format

```markdown
# PRP-NNN: Title

Status: Proposed
Author: @<agent>
Submitted: YYYY-MM-DD

## Abstract
One paragraph summary.

## Motivation
Why this change is needed.

## Specification
What exactly would change.

## Impact
Affected protocols, runtime behaviour, or files.
```

---

## Where Proposals Live

`/data/foundation/proposals/PRP-NNN.md`

Register each proposal in `/data/foundation/proposals/index.md` immediately on creation.
