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
│   │   ├── WORKFLOW.md               ← how work is planned, executed, reviewed, closed
│   │   ├── RECOVERY.md               ← errors, blockers, escalation chain
│   │   ├── VALIDATION.md             ← compliance rules and validate/run usage
│   │   └── PROPOSALS.md              ← change proposal lifecycle
│   ├── sops/
│   │   ├── index.md
│   │   ├── ivy.md                    ← @ivy operational playbook
│   │   ├── nova.md                   ← @nova operational playbook
│   │   ├── sentinel.md               ← @sentinel operational playbook
│   │   └── template.md               ← blank SOP for new agents
│   ├── library/
│   │   └── index.md                  ← permanent knowledge base (empty, grows with use)
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
    │   ├── AGENTS.md                 ← @ivy identity and responsibilities
    │   └── tasks/
    │       └── index.md
    ├── nova/
    │   ├── index.md
    │   ├── CONTEXT.md
    │   ├── AGENTS.md                 ← @nova identity and responsibilities
    │   └── tasks/
    │       └── index.md
    ├── sentinel/
    │   ├── index.md
    │   ├── CONTEXT.md
    │   └── AGENTS.md                 ← @sentinel identity and responsibilities
    └── _agent/                       ← template for adding new agents (not deployed)
        ├── index.md
        ├── CONTEXT.md
        ├── AGENTS.md
        └── tasks/
            └── index.md
```

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
