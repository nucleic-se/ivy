# SOP: Protocol Review

**Owner:** @ivy
**Trigger:** Monthly schedule (`protocol_review_monthly`) or explicit @architect request

---

## Hard constraint

**Agents MUST NOT edit AGENTS.md, SOPs, or WORKFLOW.md as a result of this SOP.**

All proposed changes require @architect approval via PRP before implementation. The output of this SOP is a findings report and zero or more PRP stubs — never direct edits to protocol files.

---

## Script Steps

**S1: Read current instructions**
- Read `/AGENTS.md` — authority, rules, roster.
- Read own SOP at `/data/sops/ivy.md`.
- Read `/data/protocols/WORKFLOW.md` — look for sections that feel misaligned with actual practice.

**S2: Review against recent history**
- `history/search { query: "error OR blocker OR failed OR retry" }` — find recurring failure patterns.
- `history/search { query: "protocol OR rule OR AGENTS" }` — find rule-related discussions.
- Note: which rules were invoked correctly? Which were ignored, misapplied, or unclear?

**S3: Identify issues**
For each issue found, write a structured entry to `/tmp/protocol-review-<date>/findings.md`:
```
Issue: <one sentence>
Evidence: <specific log entry, message, or pattern>
Affected rule: <AGENTS.md rule N / WORKFLOW.md section / SOP section>
Proposed change: <specific text, or "needs discussion">
Severity: minor (wording) | moderate (gap) | major (active harm)
```
If no issues found: document that explicitly and proceed to S5.

**S4: Draft PRPs for substantive changes**
- For each moderate or major issue: draft a PRP stub at `/data/foundation/proposals/PRP-NNN-<slug>.md`.
  Use the format from `/data/protocols/PROPOSALS.md`.
- Minor wording fixes (typos, clarity): list separately in the findings report. These do not require a PRP but still require @architect approval before editing the file.
- Do not draft PRPs speculatively — only for issues with clear evidence.

**S5: Close**
- Reset CONTEXT.md.
- DM @architect (not room, not @nova): "Protocol review complete. N issues found." Attach findings path and any PRP paths.
- If no issues: one line — "Protocol review complete — no issues found."

---

## Failure handling

- `history/search` returns nothing → note it; continue with reading-only review.
- Cannot parse a rule as written → that ambiguity is itself an issue worth flagging.
- PRP numbering conflict → check `/data/foundation/proposals/index.md` for the next available number.
