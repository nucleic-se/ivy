# @architect Trigger Reference

Quick reference for all natural-language triggers that influence agent behaviour. Say these in the room unless noted as **DM**.

---

## Lab Mode (Free Time)

Triggers the free-time loop for agents that have no assigned work. Both @ivy and @nova run independently.

| Phrase | Effect |
|---|---|
| `lab mode` / `free time` / `lab time` | Heartbeat → 120,000ms; agents begin working through `lab/ideas.md` |
| `lab mode, heartbeat <N>` | Same, but use N ms instead of the default (e.g. `lab mode, heartbeat 60000`) |
| `locked` | Heartbeat stays at current value; agents loop continuously without returning to null between experiments |
| `stop` / `unlock` | End lab mode; agents return to normal self-managed heartbeat tiers |

Agents' lab workspaces are at `/home/<agent>/lab/`. Work stays there until explicitly moved to `/data/`.

---

## Heartbeat Control

Agents self-manage heartbeat by default. You can override this.

| Phrase | Effect |
|---|---|
| `keep it at N minutes` / `lock your heartbeat at Nms` | Agent enters Locked mode at that value; records in CONTEXT.md |
| `unlock heartbeat` / `resume self-managing` / `manage your own heartbeat` | Releases lock; agent immediately applies the correct self-managed tier |
| Set a new explicit value | Replaces the previous lock value (does not release it) |

Self-managed tiers (when not locked):

| State | heartbeatMs |
|---|---|
| Active work | 60,000 (1 min) |
| Awaiting direction | 300,000 (5 min) |
| No active project, intake empty | null (off) |

---

## Routing and Wake Behaviour

| Action | Effect |
|---|---|
| Post in room (no @mention) | @ivy picks up by default; @nova and @sentinel stay silent |
| `@nova` in a room message | @nova responds directly for that thread |
| `@sentinel` in a room message | @sentinel responds directly |
| DM to @ivy / @nova / @sentinel | Private thread; agent responds only to the DM, not to the room |

@ivy: wakeMode `all` — wakes on every room message.
@nova: wakeMode `mentions` — wakes only when mentioned or DM'd.
@sentinel: wakeMode `mentions` — wakes only when mentioned or DM'd.

---

## @sentinel Validation

@sentinel runs `validate/run` and reports violations. You can trigger it by mentioning it in the room.

| Phrase | Effect |
|---|---|
| `@sentinel run` / `@sentinel check` | Runs validate/run on the full sandbox |
| `@sentinel check /path` | Runs validate/run scoped to that path |

---

## Proposals (PRPs)

Agents cannot self-approve protocol or AGENTS.md changes. They must file a PRP.

| Phrase | Effect |
|---|---|
| `approved` / `approve PRP-NNN` | Agent proceeds with the proposed change |
| `rejected` / `reject PRP-NNN` | Agent discards the proposal |

See `data/protocols/PROPOSALS.md` for full lifecycle.

---

## Behavioral Feedback

Give an agent a behavioral correction that persists across context resets. DM the target agent.

**Send as a DM to the target agent** (not in the room).

| Format | Effect |
|---|---|
| `feedback: <rule>` | Agent writes the correction to `home/<agent>/CORRECTIONS.md` before acknowledging. Auto-loaded every tick — persists across context resets. |

Agents also self-review at the end of each lab session (when `ideas.md` becomes empty). You do not need to wait for lab end — `feedback:` works any time.

---

## Per-Agent LLM Override

Set these env vars before starting ivy to route specific agents through a different model:

| Var | Example |
|---|---|
| `LLM_PROVIDER` | App-wide default (`anthropic`, `gemini`, `ollama`) |
| `IVY_LLM_PROVIDER` | Override for @ivy only |
| `NOVA_LLM_PROVIDER` | Override for @nova only |
| `SENTINEL_LLM_PROVIDER` | Override for @sentinel only |
