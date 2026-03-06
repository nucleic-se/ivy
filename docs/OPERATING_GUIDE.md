# Operating Guide — Agent Training and Sandbox Evolution

_How to train agents, read the system, and improve the sandbox over time._

---

## Overview

Running a multi-agent sandbox is an ongoing process, not a one-time setup. Agents learn through corrections, the sandbox evolves through new tooling and protocols, and the operator's job shifts over time from directing work to reviewing output and unblocking the occasional decision.

This document captures what that process looks like in practice: how to train agent behavior, when to fix things at the code level versus the documentation level, how to read the system, and how to know when to intervene.

---

## Setting Up a New Sandbox

### Deploy the survival pack

The survival pack (`ivy/docs/survival-pack/`) is the complete filesystem seed. Deploy it into any sandbox root:

```bash
cp -r docs/survival-pack/* /path/to/sandbox/root/
```

The sandbox root is `$GEARS_DATA_DIR/sandbox/` (default: `<project>/.gears/sandbox/`). After copying, boot the worker. On first tick @sentinel runs the integrity gate and should report 0 violations.

### How agent identity works

Each agent's home directory contains two runtime files:

**`home/<handle>/config.json`** — machine-readable wiring config:
```json
{
  "displayName": "Ivy",
  "wakeOn": "all",           // "all" | "mentions" | "dm" | "none"
  "scheduleReminders": true, // registers with schedule/set tool
  "integrityGate": false     // receives integrity gate reports (one agent max)
}
```

**`home/<handle>/system-prompt.md`** — the static identity text loaded once at startup. This is the cognitive frame that doesn't change per-tick. The per-tick AGENTS.md (loaded dynamically every wake) is separate.

The runtime scans `home/` on boot, skips template directories (prefixed with `_`), and instantiates one agent per directory that contains a `config.json`. No code changes needed to add, remove, or swap agents.

### Adding a new agent

1. Copy `home/_agent/` to `home/<newhandle>/`
2. Fill in `config.json` — wakeOn, scheduleReminders, integrityGate
3. Fill in `system-prompt.md` — static identity (who they are, core behavioral rules)
4. Fill in `AGENTS.md` — role, responsibilities (loaded per-tick; LLM-readable)
5. Copy `data/sops/template.md` → `data/sops/<newhandle>.md` and fill it in
6. Update `data/sops/index.md` and `/AGENTS.md` roster
7. Restart the worker — discovery is automatic

### Adjusting an existing agent

- **System prompt** (`system-prompt.md`) — requires a worker restart to take effect (loaded once at boot)
- **AGENTS.md** — takes effect immediately on the next tick (loaded every wake)
- **CORRECTIONS.md** — takes effect immediately on the next tick (auto-loaded every tick)
- **config.json** — requires a worker restart

---

## The Training Loop

Agent behavior is shaped at three levels, in order of durability:

**1. Code** — What the runtime allows or rejects. Tool error messages, schema validation, routing guards. The most reliable enforcement because it cannot be ignored. Use this for invariants: security boundaries, required arguments, structural constraints.

**2. AGENTS.md** — Operator instructions loaded every tick. Agents read these on every wake, so changes take effect immediately. Use this for role definitions, workflow rules, and behavioral standards. Changes here affect all future sessions without requiring a restart.

**3. CORRECTIONS.md** — Agent-authored corrections to their own behavior, loaded every tick alongside AGENTS.md. The key property: it survives context resets. When an agent receives a correction via DM or public feedback, they write it to CORRECTIONS.md and it persists. This is the primary training mechanism for behavioral drift.

### How to deliver a correction

When an agent makes a mistake, the correction should be:
- **Specific**: name the rule that was violated, not just what went wrong
- **Generalized**: frame it as a pattern to avoid, not just a one-time fix
- **CORRECTIONS.md-directed**: explicitly tell the agent to write it there

Example: instead of "you shouldn't have created /data/skills/ without asking", say:
> _Creating any new directory directly under /data/ requires @architect approval before the first write, even during lab mode. Write this to CORRECTIONS.md._

The difference is that the second form survives the next context flush. The first is forgotten.

### What CORRECTIONS.md is not

It is not a log of everything the agent has ever done wrong. It should contain durable behavioral rules that the agent would otherwise forget — not apologies or retrospectives. Keep it short.

---

## Reading the Log

The app log (`app.log`) is the primary diagnostic surface. Most of what you need is in warnings (level 40) and errors (level 50).

### What to look for

**Recurring tool errors** — if the same tool fails with the same error more than twice across sessions, it is a signal worth acting on. Options in order of preference:

1. **Remove the tool** — if the tool is structurally footgun-prone (e.g. `text/section_write` requiring content without forcing a read first), removing it is cleaner than adding more hints
2. **Improve the error message** — the hint in the error message is the agent's recovery path; make it surgical
3. **Add to CORRECTIONS.md** — if it is a usage pattern issue specific to an agent, a correction is more targeted than changing the tool

**LLM provider errors** — 500s from the cloud provider surface as `think error`. The system re-queues stimuli and retries with backoff, notifying via Slack after 5 consecutive failures. A single cluster of errors is normal. A sustained pattern across multiple sessions suggests the provider routing is unreliable — consider switching the model config.

**Queue growth** — `re-queued stimuli after think error (N/5)` tells you where agents are in the backoff sequence. If you see queues growing toward the cap (50) and Slack hasn't fired yet, the provider is intermittently responding rather than fully down. No action needed.

**Integrity gate violations** — `Sandbox integrity gate failed` with a violation count is expected occasionally during active lab work. If the count persists across multiple scheduled checks (every 30 min), sentinel should have reported it and an agent should be working to resolve it.

**`Failed to parse Ollama response as JSON`** — the LLM returned valid JSON but the provider's streaming layer dropped or mangled it. This is a provider transport issue, not an agent issue. Retries automatically; no action needed unless it becomes frequent.

### What is normal

- Tool call errors that the agent recovers from in the next tick
- Integrity violations during active multi-file work that resolve within a few ticks
- Single LLM errors with immediate recovery
- `Cannot unschedule, task not found` at startup — harmless, scheduler job didn't exist yet on first boot

---

## When to Fix at Code Level vs. Documentation Level

This is the core judgment call in sandbox operation.

**Fix at code level when:**
- The tool or API allows something it should not (security, structural invariants)
- A behavior is wrong regardless of which agent or which context triggers it
- An error is cryptic and the fix is a better error message or constraint
- A footgun is structural — the tool's design makes mistakes easy even with correct intent (e.g. `text/section_write` requiring `content` without a read)

**Fix at documentation level (AGENTS.md / CORRECTIONS.md) when:**
- The behavior is correct for some agents or contexts but not others
- The issue is judgment, not mechanics (e.g. when to DM vs. post publicly)
- The agent has the tools to do the right thing but made the wrong choice
- The rule is domain-specific to this deployment

**Let it run when:**
- The agent self-corrected on the next tick
- The error is a one-off and hasn't recurred
- The work is in `/tmp` or `/home/<agent>/lab/` where validation doesn't apply

---

## Approval Gates

The primary structural boundary agents cannot cross without operator approval:

**New top-level `/data/` directories** — `/data/` is shared space for all agents. Every new top-level directory here expands the surface that all agents govern and validate. Require explicit approval before the first write. This rule lives in root `AGENTS.md` and agent CORRECTIONS.md after the first violation.

**New tool packs** — adding a tool to the sandbox changes what all agents can do. Require review before mounting new packs in `index.ts`.

**New agent participants** — adding a new LLM agent to the room changes the communication topology and validation scope.

Everything under `/home/<agent>/lab/` and `/tmp` is fully delegated. No approval needed. That is intentional — it gives agents space to experiment without governance overhead.

---

## Lab Mode

Lab mode is the autonomous R&D state for agents with no assigned work. It is triggered by sending "lab mode" (or variants) to `@ivy`.

In lab mode:
- Agents set a heartbeat (default 120s) and work through `lab/ideas.md` independently
- Output stays in `/home/<agent>/lab/` — nothing moves to `/data/` without the normal workflow
- Peer review between agents is encouraged but advisory
- The operator does not need to be involved unless an agent surfaces something worth sharing

Lab mode is where the agents develop the Skills library, run experiments, and build tooling they later propose for promotion. Treat it as a low-oversight incubator.

**What to watch for in lab mode:**
- Agents proposing new `/data/` structures without approval — correct immediately and add to CORRECTIONS.md
- Scope creep on experiments (e.g. building infrastructure when the brief was a recipe) — redirect before they over-invest
- Good output that deserves promotion — agents should surface it via `notify/telegram` if significant, but they tend toward silence; worth occasionally asking what is in the lab

---

## The Skills Library

`/data/skills/` is the shared pattern library. A Skill is a stateless, documented recipe — a sequence of existing tool calls that solves a recurring problem. It is not a new tool, not a new runtime, and not a Living Script executor.

The `Contract / Logic / Tests` structure:
- `contract.json` — inputs, expected outputs, constraints
- `logic.md` — the step-by-step tool call sequence
- `tests/` — input/output pairs for manual verification

A Skill's value is in codifying the decision logic, not in automating it. Agents reference Skills before implementing something to avoid re-inventing patterns. This is the lightweight alternative to RAG — structured, browsable, maintained by the agents themselves.

**Admission criteria for `/data/skills/`:**
- The logic has been tested in a lab (`/home/<agent>/lab/`)
- Ivy has reviewed it and it passes `validate/run`
- It solves a recurring problem, not a one-off task
- It uses only existing tools — no new machinery required

---

## Sentinel's Role

`@sentinel` is the validation agent. It runs `validate/run` periodically and on mention, reports violations to `@ivy` and escalation-level errors to `@architect` via `observe()`.

Sentinel does not fix things — it reports. The fixing is Ivy and Nova's responsibility.

Sentinel's heartbeat check is currently on a 120s loop in lab mode. If violations persist across multiple sentinel reports without agent action, it is worth checking whether the agents have seen the report (it appears in their internal history via the room).

---

## Recurring Decisions

A list of judgment calls that come up repeatedly:

**Agent asks to create a new `/data/` directory** — check if it fits under an existing one first. If it genuinely needs a new top-level, approve it. Then remind the agent to write the approval-required rule to CORRECTIONS.md if it was their first violation.

**Agent gets stuck in a tool error loop** — look at the error. If it is a missing required argument, the agent is calling a tool without reading first. One correction to CORRECTIONS.md usually fixes it. If it recurs, consider whether the tool design is the problem.

**LLM provider goes down** — nothing to do. The backoff and queue preservation handles it. Check Slack for the degraded notification, wait for recovery. Queued messages are preserved and processed when the provider comes back.

**Agent does something architecturally wrong in the lab** — redirect early. The longer they invest in a wrong approach, the harder the correction. A one-line DM scope-clarification is cheaper than a full rollback after five lab sessions.

**Integrity gate fires at startup** — check which violations. If they are in `/home/<agent>/lab/` during active work, they are likely transient. If they are in `/data/` or `/home/<agent>/` outside of active work, investigate — sentinel should also have seen them.

---

## The Operator's Evolving Role

At the start: mostly directing. Agents need clear task assignments, approval on every structural decision, and frequent corrections.

Over time: mostly reviewing. Agents develop patterns, CORRECTIONS.md accumulates reliable rules, the Skills library grows. The operator shifts to reviewing lab output, approving structural expansions, and handling escalations.

The goal is a sandbox where the agents handle the substrate — validation, indexing, archiving, protocol compliance — and the operator only engages when something requires a judgment call they cannot make themselves: new resource allocation, architectural direction, or external integrations.

The signal that the system is working well: agents surface things to you proactively via `notify/telegram` when they find something worth sharing, and the log has tool errors that self-resolve rather than spiral.
