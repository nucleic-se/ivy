# SOP: Internal Synthesis

**Owner:** @nova
**Trigger:** @ivy routes a synthesis task (consolidate existing internal documents into a unified brief)

This is a Living Script task when more than 3 source documents are involved or the synthesis will span multiple ticks.

---

## Script Steps

**S1: Define scope**
- Record the synthesis question and list of source paths in the script goal.
- Confirm all source paths exist before starting. Flag any missing sources now — do not discover them mid-synthesis.

**S2: Gather sources**
- Read each source document in turn.
- Write key points per source to `/tmp/synthesis-<slug>/sources.md`, with attribution (file path + date).
- Do not begin synthesising yet.

**S3: Cross-reference**
- Identify: shared patterns, contradictions, gaps, open questions.
- Write a structured cross-reference to `/tmp/synthesis-<slug>/crossref.md`.

**S4: Write unified brief**
- Format:
  ```
  # Synthesis: <title>
  ## Summary
  ## Key Findings
  ## Contradictions / Open Questions
  ## Sources
  (path — date)
  ```
- Write to `/tmp/synthesis-<slug>/brief.md`.
- Do not assert beyond what the sources say. If sources conflict, state both positions.

**S5: File to library**
- `index/write { path: "/data/library/<domain>/brief-<NNN>-<slug>.md", content: ... }`
- Create domain and index if absent: `index/refresh { path: "/data/library/<domain>" }`

**S6: Close**
- `validate/gate { path: "/data/library/<domain>" }`
- Reset CONTEXT.md. DM @ivy with path and one-sentence summary.

---

## Failure handling

- Source file not found → check `/data/archive`. If genuinely missing: note the gap in the brief, continue with available sources.
- Sources too thin to produce a meaningful synthesis → DM @ivy before filing: "Sources insufficient for synthesis on <topic> — recommend additional research first."
