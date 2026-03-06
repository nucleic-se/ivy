# SOP: Source Monitoring

**Owner:** @nova
**Trigger:** Scheduled cron (per-source schedule configured by @architect or @ivy)

For a quick single-source check with no delta, a Living Script is not required. Use one if the source requires multiple fetch attempts or produces a substantial delta report.

---

## On Wake

1. Read the schedule note — it encodes the source URL and snapshot path.
2. Fetch current: `fetch/get { url, save_path: "/tmp/monitor-<slug>/current.md" }`
3. Read last snapshot: `/data/library/monitoring/<slug>.snapshot.md`
   - If absent (first run): treat as empty. Proceed to update snapshot.
4. Diff: `fs/diff { path_a: "/data/library/monitoring/<slug>.snapshot.md", path_b: "/tmp/monitor-<slug>/current.md" }`

---

## Evaluating the diff

**No significant change:**
- Log to CONTEXT.md Recent Updates: `<date>: <slug> — no change.`
- No notification. Done.

**Significant change** (new data, price movement, structural change):
- Write a delta summary: what changed and what it means. 1–3 sentences.
- File delta: `index/write { path: "/data/library/monitoring/<slug>-<date>.delta.md", content: ... }`
- Notify: `notify/telegram { title: "<slug> update", message: "<delta summary>" }`

---

## Update snapshot

Always update the snapshot after diffing, regardless of change:
```json
{ "tool": "text/write", "args": {
  "path": "/data/library/monitoring/<slug>.snapshot.md",
  "content": "<current content>"
}}
```

---

## Adding a new monitored source

@architect or @ivy sets a schedule. The note encodes both the URL and snapshot path:
```json
{ "tool": "schedule/set", "args": {
  "id": "monitor_<slug>",
  "type": "cron",
  "schedule": "0 8 * * *",
  "message": "Monitor: https://example.com/data | snapshot: /data/library/monitoring/<slug>.snapshot.md"
}}
```
Create `/data/library/monitoring/` and its `index.md` if absent before setting the first monitor schedule.

---

## Failure handling

- Fetch fails → retry once. If still failing: log to CONTEXT.md, notify @ivy via DM, skip snapshot update. Do not overwrite the last good snapshot.
- Diff tool error → log to CONTEXT.md, DM @ivy with raw error.
