# Skills

Shared pattern library. A Skill is a stateless, documented recipe — a sequence of existing tool calls that solves a recurring problem. Agents reference Skills before implementing something to avoid re-inventing patterns.

**Admission criteria:**
- Logic tested in a lab (`/home/<agent>/lab/`)
- Reviewed by @ivy and passes `validate/run`
- Solves a recurring problem, not a one-off task
- Uses only existing tools — no new machinery

## Structure

Each Skill lives in its own directory:
```
skills/
└── <skill-name>/
    ├── contract.json   ← inputs, expected outputs, constraints
    ├── logic.md        ← step-by-step tool call sequence
    └── tests/          ← input/output pairs for manual verification
```

## Contents
- `index.md`: This file.
