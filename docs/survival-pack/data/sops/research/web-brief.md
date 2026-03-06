# SOP: Web Research Brief

**Owner:** @nova
**Trigger:** @ivy routes a research task requiring external sources

This is a Living Script task. Create the script with `script/create` before fetching any URLs.

---

## Script Steps

**S1: Define scope**
- Write the research question, target URLs, and acceptance criteria into the script goal.
- Record the script path in CONTEXT.md Mini Checklist immediately.
- Do not fetch anything yet — goal and criteria first.

**S2: Fetch sources**
- For each URL: `fetch/get { url, save_path: "/tmp/research-<slug>/src-N.md" }`
- Max 5 URLs per script. For broader research, scope a second script.
- Fetch failure: try one alternative URL for the same source. If still blocked, note it in script state and continue with remaining sources.

**S3: Extract**
- Read each saved file. Extract key claims, data points, and quotes relevant to the research question.
- Write extracts to `/tmp/research-<slug>/extracts.md` — one section per source, with attribution (URL).
- Discard irrelevant content. Do not copy verbatim blocks.

**S4: Synthesize**
- Read `extracts.md`. Write a unified brief answering the research question.
- Format:
  ```
  # Brief: <title>
  ## Summary
  (3–5 sentences answering the question directly)
  ## Key Findings
  (bullets)
  ## Sources
  (URL — retrieval date)
  ```
- Write to `/tmp/research-<slug>/brief.md`.

**S5: File to library**
- Determine the domain subdirectory: `/data/library/<domain>/`
- Create domain dir and index if absent: `index/refresh { path: "/data/library/<domain>" }`
- File atomically: `index/write { path: "/data/library/<domain>/brief-<NNN>-<slug>.md", content: ... }`
  NNN = zero-padded sequence within the domain (001, 002…). Check the existing index to pick the next number.

**S6: Close**
- `validate/gate { path: "/data/library/<domain>" }`
- Reset CONTEXT.md: clear checklist, `Current Task: awaiting-direction`.
- DM @ivy: what was researched, path to brief, key finding in one sentence.

---

## Failure handling

- All fetches fail → DM @ivy before closing: "Unable to retrieve sources for <topic> — recommend re-scoping or providing alternative URLs."
- Sources retrieved but yielding no signal → DM @ivy: "Research on <topic> yielded insufficient signal. Recommend abandoning or re-scoping." Do not file a brief.
- `validate/gate` fails → fix violations before DMing @ivy.
