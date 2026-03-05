/**
 * ScriptToolPack — Living Script tools for structured multi-step task execution.
 *
 * Mounts at /tools/script/ with six tools:
 *
 *   script/create     — scaffold a new Living Script and register it in parent index.md
 *   script/status     — compact overview: step list with markers, current position, attempt count
 *   script/read_step  — read only the current (or named) step + state block (token-efficient)
 *   script/advance    — mark current step done, append handoff log entry, move pointer to next
 *   script/fail_step  — record failure, increment attempt counter; signals escalation at threshold
 *   script/set_state  — update scratchpad without advancing
 *
 * Living Script format
 * ────────────────────
 * Steps use machine-readable markers:
 *   [ ] pending   [/] current   [x] done   [!] failed
 *
 * The State section tracks current step ID, cumulative attempt counter, and a free-form
 * scratchpad. The Handoff Log accumulates per-step completion records so any agent (or the
 * same agent after a context flush) can orient itself by reading the most recent entry.
 *
 * Escalation
 * ──────────
 * script/fail_step returns { escalate: true } when Attempts reaches ESCALATE_THRESHOLD.
 * The tool never emits side-effects (no DMs, no room messages) — the calling agent acts on
 * the signal. This keeps the tool decoupled from the room/participant layer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString, normAgentPath, isDocumentedInIndex } from './pack-helpers.js';

// ─── Constants ───────────────────────────────────────────────────

const ESCALATE_THRESHOLD = 3;
const MAX_SCRATCHPAD_BYTES = 1024;

// Step line pattern: `- [x] S1: Title text`
const STEP_LINE_RE = /^(- \[)([x\/ !])(\] S\d+(?:\.\d+)*: .+)$/;

// ─── Types ───────────────────────────────────────────────────────

type StepMarker = 'x' | '/' | ' ' | '!';

interface StepInfo {
    id: string;
    title: string;
    marker: StepMarker;
    lineIndex: number; // index in content.split('\n')
}

interface ScriptState {
    current: string;
    attempts: number;
    scratchpad: string;
}

// ─── Parsing ─────────────────────────────────────────────────────

/**
 * Extract the body of a `## SectionName` section as a string.
 * Returns null if the section is not found.
 * Body spans from after the header line to the start of the next `## ` header or EOF.
 */
function extractSection(content: string, name: string): string | null {
    const headerRe = new RegExp(`^## ${escapeRegex(name)}\\s*$`, 'm');
    const m = content.match(headerRe);
    if (!m || m.index === undefined) return null;

    const bodyStart = m.index + m[0].length;
    const rest = content.slice(bodyStart);
    const nextHeader = rest.match(/\n##[ \t]/);
    const bodyEnd = nextHeader !== null ? bodyStart + nextHeader.index! : content.length;

    return content.slice(bodyStart, bodyEnd);
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSteps(content: string): StepInfo[] {
    const steps: StepInfo[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(/^- \[([x\/ !])\] (S\d+(?:\.\d+)*): (.+)$/);
        if (m) {
            steps.push({
                id: m[2]!,
                title: m[3]!.trim(),
                marker: m[1]! as StepMarker,
                lineIndex: i,
            });
        }
    }
    return steps;
}

function parseState(content: string): ScriptState {
    const section = extractSection(content, 'State') ?? '';
    const currentMatch = section.match(/^Current:\s*(.*)$/m);
    const attemptsMatch = section.match(/^Attempts:\s*(\d+)$/m);
    const scratchpadMatch = section.match(/^Scratchpad:\s*(.*)$/m);
    return {
        current: currentMatch?.[1]?.trim() ?? '',
        attempts: attemptsMatch ? parseInt(attemptsMatch[1]!, 10) : 0,
        scratchpad: scratchpadMatch?.[1]?.trim() ?? '',
    };
}

function parseHeaderField(content: string, field: string): string {
    const m = content.match(new RegExp(`^${escapeRegex(field)}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim() ?? '';
}

// ─── Mutations (string-level, no full re-serialisation) ──────────

/**
 * Replace the marker character of a specific step line.
 * Operates by scanning for the step ID prefix to avoid ambiguity.
 */
function setStepMarker(content: string, stepId: string, marker: StepMarker): string {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (STEP_LINE_RE.test(line) && line.includes(`] ${stepId}: `)) {
            lines[i] = line.replace(STEP_LINE_RE, `$1${marker}$3`);
            return lines.join('\n');
        }
    }
    throw new Error(`Step "${stepId}" not found in script`);
}

/**
 * Update a single key in the `## State` section.
 * Only replaces the value on the matching `Key: ...` line.
 */
function updateStateField(content: string, key: string, value: string): string {
    const fieldRe = new RegExp(`(^${escapeRegex(key)}:[ \\t]*)(.*)$`, 'm');
    if (!fieldRe.test(content)) {
        throw new Error(`State field "${key}" not found`);
    }
    return content.replace(fieldRe, `$1${value}`);
}

/**
 * Update the top-level `Status: ...` header field.
 */
function updateStatus(content: string, status: string): string {
    return content.replace(/^Status:\s*.+$/m, `Status: ${status}`);
}

/**
 * Append a handoff log entry under `## Handoff Log`.
 * Creates the section if it doesn't exist.
 */
function appendHandoffEntry(content: string, entry: string): string {
    const headerRe = /^## Handoff Log\s*$/m;
    if (headerRe.test(content)) {
        // Append before EOF (or before any trailing newline cluster).
        return content.trimEnd() + '\n\n' + entry + '\n';
    }
    // Section absent — append it.
    return content.trimEnd() + '\n\n## Handoff Log\n\n' + entry + '\n';
}

// ─── Script scaffold ─────────────────────────────────────────────

function buildScript(
    title: string,
    owner: string,
    goal: string,
    steps: string[],
    created: string,
): string {
    const stepLines = steps.map((s, i) => {
        const id = `S${i + 1}`;
        const marker = i === 0 ? '/' : ' ';
        return `- [${marker}] ${id}: ${s}`;
    });

    const firstId = steps.length > 0 ? 'S1' : '';

    return [
        `# Script: ${title}`,
        '',
        `Owner: ${owner}`,
        `Goal: ${goal}`,
        `Created: ${created}`,
        `Status: active`,
        '',
        '## Acceptance Criteria',
        '- [ ] (define before starting)',
        '',
        '## Steps',
        ...stepLines,
        '',
        '## State',
        `Current: ${firstId}`,
        'Attempts: 0',
        'Scratchpad: ',
        '',
        '## Handoff Log',
        '',
    ].join('\n');
}

// ─── ScriptToolPack ──────────────────────────────────────────────

export class ScriptToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('script', [
            this.createTool(),
            this.listTool(),
            this.statusTool(),
            this.readStepTool(),
            this.advanceTool(),
            this.failStepTool(),
            this.setStateTool(),
        ]).createLayer();
    }

    // ── script/create ────────────────────────────────────────────

    private createTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'create',
            description: [
                'Scaffold a new Living Script file and register it in the parent index.md.',
                'Steps are provided as an array of title strings; S1, S2, ... IDs are assigned automatically.',
                'S1 is set as the current step. Status is active.',
                'Returns { created, path, step_count }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path for the new script file (e.g. /home/nova/tasks/my-task.md).',
                    required: true,
                },
                title: {
                    type: 'string',
                    description: 'Script title — appears in the heading and index entry.',
                    required: true,
                },
                goal: {
                    type: 'string',
                    description: 'One sentence: what does done look like?',
                    required: true,
                },
                steps: {
                    type: 'string',
                    description: 'JSON array of step title strings, e.g. ["Research", "Draft", "Validate"].',
                    required: true,
                },
                owner: {
                    type: 'string',
                    description: 'Agent handle, e.g. @nova. Defaults to the caller.',
                    required: false,
                },
            },
            returns: '{ created: true, path: string, step_count: number, registered: boolean, hint: string }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const title = requireString(args, 'title');
                const goal = requireString(args, 'goal');
                const owner = typeof args['owner'] === 'string' ? args['owner'] : callerHandle;

                // Parse steps — accept JSON string or already-parsed array.
                let rawSteps = args['steps'];
                if (typeof rawSteps === 'string') {
                    try { rawSteps = JSON.parse(rawSteps); } catch {
                        throw new Error('"steps" must be a JSON array of strings, e.g. ["Step 1", "Step 2"]');
                    }
                }
                if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
                    throw new Error('"steps" must be a non-empty array of strings');
                }
                const steps = rawSteps.map((s, i) => {
                    if (typeof s !== 'string' || !s.trim()) {
                        throw new Error(`Step at index ${i} must be a non-empty string`);
                    }
                    return s.trim();
                });

                const created = new Date().toISOString().slice(0, 10);
                const content = buildScript(title, owner, goal, steps, created);

                // Write the script file.
                sandbox.assertWritable(agentPath, callerHandle);
                const realPath = sandbox.resolveForWrite(agentPath);
                fs.mkdirSync(path.dirname(realPath), { recursive: true });
                fs.writeFileSync(realPath, content, 'utf-8');

                // Register in parent index.md.
                const agentDir = path.dirname(agentPath);
                const agentIndexPath = `${agentDir}/index.md`;
                const name = path.basename(agentPath);

                let existingIndex = '';
                try {
                    existingIndex = fs.readFileSync(
                        sandbox.resolveExisting(agentIndexPath), 'utf-8');
                } catch { /* index.md may not exist yet */ }

                let registered = false;
                if (!isDocumentedInIndex(name, false, existingIndex)) {
                    sandbox.assertWritable(agentIndexPath, callerHandle);
                    const realIndex = sandbox.resolveForWrite(agentIndexPath);
                    const sep = existingIndex.length > 0 && !existingIndex.endsWith('\n') ? '\n' : '';
                    fs.mkdirSync(path.dirname(realIndex), { recursive: true });
                    fs.appendFileSync(realIndex, `${sep}- \`${name}\`: ${title}\n`, 'utf-8');
                    registered = true;
                }

                return {
                    created: true,
                    path: agentPath,
                    step_count: steps.length,
                    registered,
                    hint: `Add this path to your CONTEXT.md Mini Checklist so you can find it after a context flush. If you lose it, use script/list { dir: "${path.dirname(agentPath)}" } to rediscover it.`,
                };
            },
        };
    }

    // ── script/list ──────────────────────────────────────────────

    private listTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'list',
            description: [
                'List Living Script files in a directory, optionally filtered by status.',
                'Use this to rediscover active scripts after a context flush when the path is unknown.',
                'Scans only the immediate directory (non-recursive).',
                'Returns { scripts: [{ path, title, status, current, attempts }] }.',
            ].join(' '),
            parameters: {
                dir: {
                    type: 'string',
                    description: 'Absolute sandbox path to the directory to scan (e.g. /home/nova/tasks).',
                    required: true,
                },
                status: {
                    type: 'string',
                    description: '"active" (default), "complete", "all".',
                    required: false,
                },
            },
            returns: '{ scripts: [{ path, title, status, current, attempts }] }',
            examples: [
                '{"calls": [{"tool": "script/list", "args": {"dir": "/home/nova/tasks"}}]}',
            ],
            handler: async (args) => {
                const agentDir = normAgentPath(requireString(args, 'dir'));
                const statusFilter = typeof args['status'] === 'string' ? args['status'] : 'active';

                const realDir = sandbox.resolveExisting(agentDir);
                const entries = fs.readdirSync(realDir, { withFileTypes: true });

                const scripts: Array<{ path: string; title: string; status: string; current: string; attempts: number }> = [];

                for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
                    try {
                        const agentPath = `${agentDir}/${entry.name}`;
                        const content = fs.readFileSync(
                            sandbox.resolveExisting(agentPath), 'utf-8',
                        );
                        // Must look like a Living Script (has `# Script:` heading).
                        const titleMatch = content.match(/^# Script:\s*(.+)$/m);
                        if (!titleMatch) continue;

                        const status = parseHeaderField(content, 'Status') || 'unknown';
                        if (statusFilter !== 'all' && status !== statusFilter) continue;

                        const state = parseState(content);
                        scripts.push({
                            path: agentPath,
                            title: titleMatch[1]!.trim(),
                            status,
                            current: state.current,
                            attempts: state.attempts,
                        });
                    } catch {
                        // Skip unreadable files silently.
                    }
                }

                return { scripts };
            },
        };
    }

    // ── script/status ────────────────────────────────────────────

    private statusTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'status',
            description: [
                'Return a compact overview of a Living Script: step list with markers, current position, attempt count, and status.',
                'Token-efficient — does not return step body content.',
                'Returns { title, status, current, attempts, scratchpad, steps: [{id, title, marker}] }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the Living Script file.',
                    required: true,
                },
            },
            returns: '{ title, status, current, attempts, scratchpad, steps: [{id, title, marker}] }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const content = fs.readFileSync(sandbox.resolveExisting(agentPath), 'utf-8');

                const titleMatch = content.match(/^# Script:\s*(.+)$/m);
                const title = titleMatch?.[1]?.trim() ?? '(untitled)';
                const status = parseHeaderField(content, 'Status');
                const state = parseState(content);
                const steps = parseSteps(content);

                const MARKER_LABEL: Record<string, string> = {
                    'x': 'done', '/': 'current', ' ': 'pending', '!': 'failed',
                };

                return {
                    title,
                    status,
                    current: state.current,
                    attempts: state.attempts,
                    scratchpad: state.scratchpad || null,
                    steps: steps.map(s => ({
                        id: s.id,
                        title: s.title,
                        marker: `[${s.marker}]`,
                        state: MARKER_LABEL[s.marker] ?? 'unknown',
                    })),
                };
            },
        };
    }

    // ── script/read_step ─────────────────────────────────────────

    private readStepTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'read_step',
            description: [
                'Read only the current step (or a named step) plus the State block.',
                'Much more token-efficient than reading the whole file.',
                'Increments the visit counter in State on each call.',
                'Returns { step_id, title, marker, state, last_handoff? }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the Living Script file.',
                    required: true,
                },
                step: {
                    type: 'string',
                    description: 'Step ID to read, e.g. "S2". Defaults to the current step.',
                    required: false,
                },
            },
            returns: '{ step_id, title, marker, state: { current, attempts, scratchpad }, last_handoff? }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const realPath = sandbox.resolveExisting(agentPath);
                let content = fs.readFileSync(realPath, 'utf-8');

                const state = parseState(content);
                const steps = parseSteps(content);

                const targetId = typeof args['step'] === 'string'
                    ? args['step'].trim().toUpperCase()
                    : state.current;

                if (!targetId) throw new Error('No current step set — use script/create or specify step explicitly');

                const step = steps.find(s => s.id === targetId);
                if (!step) throw new Error(`Step "${targetId}" not found in script`);

                // Find the most recent handoff log entry for this step.
                const handoffSection = extractSection(content, 'Handoff Log') ?? '';
                const entryRe = new RegExp(
                    `### ${escapeRegex(targetId)}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`, 'g'
                );
                let lastHandoff: string | null = null;
                let m: RegExpExecArray | null;
                while ((m = entryRe.exec(handoffSection)) !== null) {
                    lastHandoff = m[1]!.trim();
                }

                return {
                    step_id: step.id,
                    title: step.title,
                    marker: `[${step.marker}]`,
                    state: {
                        current: state.current,
                        attempts: state.attempts,
                        scratchpad: state.scratchpad || null,
                    },
                    last_handoff: lastHandoff,
                };
            },
        };
    }

    // ── script/advance ───────────────────────────────────────────

    private advanceTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'advance',
            description: [
                'Mark the current step done ([x]), append a handoff log entry, and move the [/] pointer to the next step.',
                'Requires "summary" — one or two sentences describing what was accomplished.',
                'If there is no next step the script Status is set to "complete".',
                'Resets Attempts to 0 on advance.',
                'Returns { advanced_from, advanced_to, complete }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the Living Script file.',
                    required: true,
                },
                summary: {
                    type: 'string',
                    description: 'REQUIRED. One or two sentences: what was accomplished in this step. Written to the Handoff Log.',
                    required: true,
                },
                result: {
                    type: 'string',
                    description: '"success" (default) or "partial".',
                    required: false,
                },
            },
            returns: '{ advanced_from: string, advanced_to: string | null, complete: boolean }',
            examples: [
                '{"calls": [{"tool": "script/advance", "args": {"path": "/home/nova/tasks/my-task.md", "summary": "Parsed 7 data points from btc_data.json, confirmed price range and timestamps."}}]}',
            ],
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const summary = requireString(args, 'summary');
                const result = typeof args['result'] === 'string' ? args['result'] : 'success';

                sandbox.assertWritable(agentPath, callerHandle);
                const realPath = sandbox.resolveExisting(agentPath);
                let content = fs.readFileSync(realPath, 'utf-8');

                const state = parseState(content);
                const steps = parseSteps(content);

                if (!state.current) throw new Error('No current step set in State');

                const currentIdx = steps.findIndex(s => s.id === state.current);
                if (currentIdx === -1) throw new Error(`Current step "${state.current}" not found in Steps list`);

                const currentStep = steps[currentIdx]!;
                const nextStep = steps[currentIdx + 1] ?? null;

                // Mark current step done.
                content = setStepMarker(content, currentStep.id, 'x');

                if (nextStep) {
                    // Move pointer to next step.
                    content = setStepMarker(content, nextStep.id, '/');
                    content = updateStateField(content, 'Current', nextStep.id);
                } else {
                    // No next step — script complete.
                    content = updateStateField(content, 'Current', '(complete)');
                    content = updateStatus(content, 'complete');
                }

                // Reset attempt counter.
                content = updateStateField(content, 'Attempts', '0');

                // Append handoff log entry.
                const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
                const entry = [
                    `### ${currentStep.id}`,
                    `Result: ${result}`,
                    `Completed: ${timestamp}`,
                    `Summary: ${summary}`,
                ].join('\n');
                content = appendHandoffEntry(content, entry);

                fs.writeFileSync(realPath, content, 'utf-8');

                return {
                    advanced_from: currentStep.id,
                    advanced_to: nextStep?.id ?? null,
                    complete: nextStep === null,
                };
            },
        };
    }

    // ── script/fail_step ─────────────────────────────────────────

    private failStepTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'fail_step',
            description: [
                'Record a failure on the current step: increment Attempts, append handoff log entry.',
                `Returns { escalate: true } when Attempts reaches ${ESCALATE_THRESHOLD} — the caller should DM @architect with a blocker report.`,
                'The step remains current ([/]) so the agent can retry or be unblocked.',
                'Returns { step_id, attempts, escalate }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the Living Script file.',
                    required: true,
                },
                reason: {
                    type: 'string',
                    description: 'What failed and why. Written to the Handoff Log.',
                    required: true,
                },
            },
            returns: `{ step_id: string, attempts: number, escalate: boolean }`,
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const reason = requireString(args, 'reason');

                sandbox.assertWritable(agentPath, callerHandle);
                const realPath = sandbox.resolveExisting(agentPath);
                let content = fs.readFileSync(realPath, 'utf-8');

                const state = parseState(content);
                if (!state.current || state.current === '(complete)') {
                    throw new Error('No active current step to fail');
                }

                const newAttempts = state.attempts + 1;

                // Increment attempt counter.
                content = updateStateField(content, 'Attempts', String(newAttempts));

                // Append handoff log entry.
                const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
                const entry = [
                    `### ${state.current}`,
                    `Result: fail`,
                    `Attempt: ${newAttempts}`,
                    `Timestamp: ${timestamp}`,
                    `Reason: ${reason}`,
                ].join('\n');
                content = appendHandoffEntry(content, entry);

                fs.writeFileSync(realPath, content, 'utf-8');

                const escalate = newAttempts >= ESCALATE_THRESHOLD;
                return {
                    step_id: state.current,
                    attempts: newAttempts,
                    escalate,
                    ...(escalate ? { escalate_hint: `${ESCALATE_THRESHOLD} consecutive failures on ${state.current} — DM @architect with a blocker report per WORKFLOW.md Recovery section` } : {}),
                };
            },
        };
    }

    // ── script/set_state ─────────────────────────────────────────

    private setStateTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'set_state',
            description: [
                'Update the Scratchpad field in the State section without advancing.',
                `Scratchpad is capped at ${MAX_SCRATCHPAD_BYTES} bytes.`,
                'Use to record mid-step discoveries, decisions, or context for the next wake.',
                'Returns { ok: true, scratchpad }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the Living Script file.',
                    required: true,
                },
                scratchpad: {
                    type: 'string',
                    description: 'Free-form text to store in the Scratchpad field.',
                    required: true,
                },
            },
            returns: '{ ok: true, scratchpad: string }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                let scratchpad = requireString(args, 'scratchpad');

                if (Buffer.byteLength(scratchpad, 'utf-8') > MAX_SCRATCHPAD_BYTES) {
                    scratchpad = scratchpad.slice(0, MAX_SCRATCHPAD_BYTES) + '…';
                }

                // Scratchpad must fit on one line for reliable field-level parsing.
                scratchpad = scratchpad.replace(/\n/g, ' ').trim();

                sandbox.assertWritable(agentPath, callerHandle);
                const realPath = sandbox.resolveExisting(agentPath);
                let content = fs.readFileSync(realPath, 'utf-8');

                content = updateStateField(content, 'Scratchpad', scratchpad);
                fs.writeFileSync(realPath, content, 'utf-8');

                return { ok: true, scratchpad };
            },
        };
    }
}
