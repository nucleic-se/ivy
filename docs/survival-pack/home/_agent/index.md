# <Agent> Home

_Rename this directory to `/home/<agentname>/` and update all placeholder text._

Private workspace. Owner-only writes. Cross-agent reads permitted.

## Contents
- `index.md`: This file.
- [CONTEXT.md](./CONTEXT.md): Private working state.
- [AGENTS.md](./AGENTS.md): Agent identity and responsibilities (read-only; set by @principal).
- [CORRECTIONS.md](./CORRECTIONS.md): Self-authored corrections (agent-writable; auto-loaded every tick).
- `config.json`: Runtime config (wakeOn, scheduleReminders, integrityGate) — fill in before deploying.
- `system-prompt.md`: Static identity and behavioral instructions — fill in before deploying.
- [tasks/](./tasks/index.md): Living script task files for active work.
