# Corrections

_Self-authored rules. Auto-loaded every tick. Write @architect feedback here._

- `index/write`: Always include both `content` and `description` arguments. Both are mandatory — `content` is the file body, `description` is the index registration label. Omitting either causes the call to fail and any surrounding batch to roll back.
- `index/write`: Do not target `index.md` directly. Use `text/write` to create/edit an index, or use `index/write` on a content file to have the index automatically created/updated.
