# Survival Pack — v1

A complete filesystem seed for a new Ivy sandbox. Copy the contents of this directory into the sandbox root and agents can self-organise from tick one.

---

## Install

```bash
cp -r docs/survival-pack/* /path/to/sandbox/root/
```

That's it. The sandbox root is the directory containing `home/`, `data/`, `tmp/`, `tools/`.

After copying, boot the app. On first tick @sentinel will run an integrity gate and should report **0 violations**.

---

## What Gets Installed

```
/
├── AGENTS.md                          ← authority, roster, rules (ivy/nova/sentinel/@architect)
├── CONTEXT.md                         ← shared cross-agent state
├── data/
│   ├── index.md
│   ├── foundation/
│   │   ├── index.md
│   │   ├── principles.md             ← system values
│   │   └── proposals/
│   │       └── index.md              ← PRP registry
│   ├── projects/
│   │   ├── index.md
│   │   └── tasks.md                  ← global intake backlog
│   ├── protocols/
│   │   ├── index.md
│   │   ├── AGENT_MANUAL.md           ← how to think and behave (cognitive guide)
│   │   ├── WORKFLOW.md               ← task lifecycle, recovery, validation, communication
│   │   └── PROPOSALS.md              ← change proposal lifecycle
│   ├── sops/
│   │   ├── index.md
│   │   ├── ivy.md                    ← @ivy operational playbook
│   │   ├── nova.md                   ← @nova operational playbook
│   │   ├── sentinel.md               ← @sentinel operational playbook
│   │   ├── template.md               ← blank SOP for new agents
│   │   ├── diary-daily.md            ← @ivy daily diary living script
│   │   ├── archive-migration.md      ← @nova weekly archive migration
│   │   ├── ledger-reconciliation.md  ← @nova daily ledger reconciliation
│   │   ├── research/                 ← research bundle (web-brief, monitoring, synthesis)
│   │   └── self/                     ← self-improvement (retrospective, protocol-review, knowledge-migration, free-time)
│   ├── library/
│   │   ├── index.md
│   │   └── technical/                ← technical references (living-script-syntax, tool patterns)
│   ├── skills/
│   │   └── index.md                  ← shared pattern library (grows with use)
│   ├── archive/
│   │   ├── index.md
│   │   └── projects/                 ← completed project workspaces
│   └── templates/
│       ├── index.md
│       ├── task.md                   ← living script task file template
│       └── project/
│           ├── index.md
│           ├── tasks.md
│           ├── CONTEXT.md
│           ├── logs/
│           │   └── index.md
│           └── research/
│               └── index.md
└── home/
    ├── ivy/
    │   ├── index.md
    │   ├── CONTEXT.md
    │   ├── AGENTS.md                 ← @ivy identity and responsibilities (read-only)
    │   ├── CORRECTIONS.md            ← @ivy self-authored corrections (auto-loaded every tick)
    │   ├── tasks/
    │   │   └── index.md
    │   └── lab/                      ← autonomous R&D workspace
    │       ├── index.md
    │       └── ideas.md
    ├── nova/
    │   ├── index.md
    │   ├── CONTEXT.md
    │   ├── AGENTS.md                 ← @nova identity and responsibilities (read-only)
    │   ├── CORRECTIONS.md            ← @nova self-authored corrections (auto-loaded every tick)
    │   ├── tasks/
    │   │   └── index.md
    │   └── lab/                      ← autonomous R&D workspace
    │       ├── index.md
    │       └── ideas.md
    ├── sentinel/
    │   ├── index.md
    │   ├── CONTEXT.md
    │   └── AGENTS.md                 ← @sentinel identity and responsibilities (read-only)
    └── _agent/                       ← template for adding new agents (not deployed)
        ├── index.md
        ├── CONTEXT.md
        ├── AGENTS.md
        ├── CORRECTIONS.md
        └── tasks/
            └── index.md
```

---

## Human Documentation

These docs live in `ivy/docs/` (the bundle source, not the sandbox). Read them before operating the sandbox:

| Document | Audience | Purpose |
|---|---|---|
| `docs/OPERATING_GUIDE.md` | Operator | How to train agents, read logs, fix issues, manage approvals — the full operating loop |
| `docs/BOOTSTRAP_GUIDE.md` | Agent / Operator | How to bring a blank sandbox to a working state from first boot |
| `docs/SANDBOX_DESIGN.md` | Architect | Design insights, best practices, and anti-patterns from operating a live multi-agent sandbox |
| `docs/TRIGGERS.md` | Operator | Runtime trigger reference — Telegram commands, schedule IDs, lab mode phrases |

Start with `OPERATING_GUIDE.md` if you are new to operating this stack.

---

## What Agents See on First Wake

Each agent boots and should:

1. Read `/AGENTS.md` — who everyone is, the rules, hard escalation boundaries
2. Read their SOP at `/data/sops/<handle>.md` — exactly what to do on each wake type
3. Read `/data/protocols/AGENT_MANUAL.md` — how to think and behave (once to internalise)
4. Read their `/home/<handle>/CONTEXT.md` — current state (blank on first boot)
5. Run `validate/run` on their home
6. Enter standby and await @architect direction

---

## Adding a New Agent Later

1. Copy `home/_agent/` to `home/<newhandle>/`
2. Fill in `home/<newhandle>/AGENTS.md` — identity, role, responsibilities
3. Copy `data/sops/template.md` to `data/sops/<newhandle>.md` and fill it in
4. Update `data/sops/index.md` to register the new SOP
5. Update `/AGENTS.md` roster
6. Run `validate/run /` — should pass

---

## Design Notes

This pack encodes the patterns that emerged from operating a live multi-agent sandbox. Key decisions:

- **Three core protocol docs** agents read per task — not 14. Compliance overhead has a direct cost in throughput.
- **SOPs as the primary anchor** — read on every heartbeat wake, not just on boot. Re-anchors agents after context flushes.
- **`AGENT_MANUAL.md` is the cognitive layer** — describes how to think, not what to do. Read once to internalise.
- **Proposals gate** — formal system change control. Only @architect approves.
- **Global intake backlog** at `/data/projects/tasks.md` — portfolio visibility without duplicating project tasks.
- **Rich project template** — `tasks.md`, `logs/`, `research/`, shared `CONTEXT.md` from day one.
- **Living script task files** — program counters that survive context window flushes.

---

_survival-pack-v1 · ivy/nova/sentinel stack_
