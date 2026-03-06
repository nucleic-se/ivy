# SOP: Free Time

**Owner:** @ivy, @nova (each runs independently)
**Trigger:** Heartbeat tick with no assigned work and no @architect messages

---

## On Wake

1. Check `lab/ideas.md`. If empty or nothing actionable: set heartbeat to null, sleep.
2. Pick the top idea. If it will take more than one tick, create a Living Script first.
3. Run it — use existing research SOPs as appropriate:
   - External research → `research/web-brief`
   - Consolidate findings → `research/synthesis`
4. File output to `lab/` using `index/write`.
5. Update `ideas.md`: mark done, note what it surfaced, add any new threads it opened.
6. **Peer review — substantive, not a rubber stamp:**
   - *Before starting:* DM the other agent with the idea and approach — catch wrong tool choices or rule violations before investing time.
   - *After completing:* DM the other agent with the output path. The reviewer should check: are tools used correctly? Does the design introduce any rule violations? Is the approach sound?
   - The purpose is to catch bad design decisions before they reach @architect. "Advisory" means feedback isn't binding — not that it should be shallow. A design spec or PRP draft warrants genuine scrutiny.
   - They may decline if busy, but skipping review on a design or spec is a risk you own.
7. **Self-correction (on session end):** When `ideas.md` is now empty and you are about to return to null — check your recent DMs from @architect or @ivy for any behavioral corrections. If corrections were given, write them to `home/<you>/CORRECTIONS.md` before going idle. That file is auto-loaded every tick and survives context resets.

8. **Heartbeat:**
   - Default on entering lab mode: `120000` ms (unless @architect specified otherwise).
   - If heartbeat is locked by @architect: do not return to null on completion — proceed directly to the next idea.
   - If heartbeat is not locked: return to null only when `ideas.md` is empty and you have nothing actionable.

---

## ideas.md format

```
## Active
- [ ] <idea> — <one sentence why>

## Done
- [x] <idea> — <what it produced> → lab/<path>
```

---

## Constraints

- Lab outputs stay in `/home/<agent>/lab/`. Do not write to `/data/` — that requires normal workflow.
- Do not surface lab work to @architect unless asked or you have something genuinely worth sharing. If you do: `notify/telegram { title: "Lab: <idea>", message: "<one line finding> → lab/<path>" }`. Use rarely.
- No approval needed for lab work from anyone. Peer review is optional and symmetric.
