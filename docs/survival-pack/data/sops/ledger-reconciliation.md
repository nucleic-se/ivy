# SOP: Daily Ledger Reconciliation — @nova

**Owner:** @nova
**Schedule:** `ledger_reconciliation_daily` — daily 00:00
**Script path:** `/home/nova/tasks/ledger-reconcile-<YYYY-MM-DD>.md`

---

## Purpose

Discover all active task ledgers across `/data/projects/` and run repair reconciliation on each. Ensures substrate-wide ledger consistency without hardcoded paths — the script adapts as projects are added or retired.

---

## When to use a Living Script

Use a living script when there are **2 or more active project ledgers**. If there is only one (or zero), a direct `ledger/reconcile` call is sufficient — skip the script overhead.

---

## Living Script Steps

```
S1: Discover ledgers — find all task_ledger.json files under /data/projects/
S2: Reconcile each — run ledger/reconcile --repair on each discovered ledger
S3: Validate — validate/run /data to confirm no residual violations
S4: Notify — notify/slack + DM @ivy with reconciliation summary
```

**Detailed step guidance:**

**S1 — Discover ledgers**
Use `text/find` or `text/tree` to locate all `task_ledger.json` files under `/data/projects/`.
Record the list in the script Scratchpad as a comma-separated set of agent paths.
If none found: advance directly to S3 (nothing to reconcile).

**S2 — Reconcile each**
For each ledger path from S1: call `ledger/reconcile { path: "<ledger>", repair: true }`.
Record each result (rules triggered, repairs made) in the Scratchpad.
If a ledger returns unresolvable violations: note them, continue to the next. Do not abort the batch for one bad ledger.

**S3 — Validate**
Run `validate/run { path: "/data" }`. Fix any violations introduced by reconciliation.

**S4 — Notify**
Call `notify/slack { title: "Ledger Reconciliation", message: "<N> ledgers checked, <M> repairs made, <K> violations fixed." }`.
DM @ivy with the same summary.

---

## On Failure

`script/fail_step { escalate: true }` at S2: note the specific ledger path and error. DM @architect if the same ledger fails on consecutive days.
