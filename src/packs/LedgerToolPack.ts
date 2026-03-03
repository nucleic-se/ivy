/**
 * LedgerToolPack — structured task ledger tools for sandbox agents.
 *
 * Mounts at /tools/ledger/ with two tools:
 *
 *   ledger/query   — filtered read of task_ledger.json (by status, owner, blocked state)
 *   ledger/update  — atomic status transition with lock enforcement and history append
 *
 * Ledger format: { project, version, tasks: Task[], history?: HistoryEntry[] }
 * Task: { id, description, status, owner?, dependencies?, validation_hash?, lock?, notes? }
 * Status machine: pending → active → completed  (no backward, no skipping)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString, normAgentPath } from './pack-helpers.js';

// ─── Types ───────────────────────────────────────────────────────

type ReconcileRule =
    | 'ORPHAN_ACTIVE'   // active task has no owner
    | 'STALE_LOCK'      // lock is set on a non-active task
    | 'DEP_VIOLATION'   // completed task has a dep that is not completed
    | 'ACTIVE_BLOCKED'  // active task has a dep that is not completed
    | 'DUPLICATE_ID';   // two tasks share the same id

interface ReconcileViolation {
    rule: ReconcileRule;
    task_id: string;
    hint: string;
}

export interface LedgerTask {
    id: string;
    description: string;
    status: 'pending' | 'active' | 'completed';
    owner?: string | null;
    dependencies?: string[];
    validation_hash?: string | null;
    lock?: string | null;
    notes?: string;
}

interface HistoryEntry {
    ts: string;
    task_id: string;
    by: string;
    from: string;
    to: string;
}

interface Ledger {
    project: string;
    version: string;
    tasks: LedgerTask[];
    history?: HistoryEntry[];
}

// ─── Constants ───────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<LedgerTask['status'], LedgerTask['status'][]> = {
    pending:   ['active'],
    active:    ['completed'],
    completed: [],
};

const VALID_STATUSES = new Set<string>(['pending', 'active', 'completed']);

// ─── Helpers ─────────────────────────────────────────────────────

function readLedger(sandbox: Sandbox, agentPath: string): { ledger: Ledger; realPath: string } {
    const realPath = sandbox.resolveExisting(agentPath);
    let content: string;
    try { content = fs.readFileSync(realPath, 'utf-8'); }
    catch { throw new Error(`Cannot read ledger: ${agentPath}`); }
    let ledger: Ledger;
    try { ledger = JSON.parse(content) as Ledger; }
    catch { throw new Error(`Invalid JSON in ledger: ${agentPath}`); }
    if (!Array.isArray(ledger.tasks)) throw new Error(`Invalid ledger: "tasks" must be an array`);
    return { ledger, realPath };
}

// ─── LedgerToolPack ──────────────────────────────────────────────

export class LedgerToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('ledger', [
            this.queryTool(),
            this.updateTool(),
            this.reconcileTool(),
        ]).createLayer();
    }

    // ── ledger/query ────────────────────────────────────────────

    private queryTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'query',
            description: [
                'Filtered read of a task_ledger.json file.',
                'Returns only matching tasks — avoids loading the full ledger into context.',
                'Filter by status (pending/active/completed), owner (@handle), or blocked_only (unmet deps).',
            ].join(' '),
            parameters: {
                ledger_path: {
                    type: 'string',
                    description: 'Absolute sandbox path to task_ledger.json',
                    required: true,
                },
                status: {
                    type: 'string',
                    description: 'Filter by status: pending, active, or completed',
                    required: false,
                },
                owner: {
                    type: 'string',
                    description: 'Filter by owner handle (e.g. @nova)',
                    required: false,
                },
                blocked_only: {
                    type: 'boolean',
                    description: 'If true, return only tasks with at least one unmet dependency',
                    required: false,
                },
            },
            returns: '{ tasks: Task[], count: number, total: number, project: string }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'ledger_path'));
                const { ledger } = readLedger(sandbox, agentPath);

                let tasks = [...ledger.tasks];

                if (typeof args['status'] === 'string') {
                    const status = args['status'];
                    if (!VALID_STATUSES.has(status)) {
                        throw new Error(`Invalid status filter: "${status}". Must be pending, active, or completed.`);
                    }
                    tasks = tasks.filter(t => t.status === status);
                }

                if (typeof args['owner'] === 'string') {
                    const owner = args['owner'];
                    tasks = tasks.filter(t => t.owner === owner);
                }

                if (args['blocked_only'] === true) {
                    const completedIds = new Set(
                        ledger.tasks.filter(t => t.status === 'completed').map(t => t.id),
                    );
                    tasks = tasks.filter(t =>
                        (t.dependencies ?? []).some(dep => !completedIds.has(dep)),
                    );
                }

                return {
                    project: ledger.project,
                    tasks,
                    count: tasks.length,
                    total: ledger.tasks.length,
                };
            },
        };
    }

    // ── ledger/update ───────────────────────────────────────────

    private updateTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'update',
            description: [
                'Atomically transition a task in task_ledger.json.',
                'Enforces: valid transitions (pending→active→completed only),',
                'dependency completion before activation, and lock ownership.',
                'Appends a timestamped history entry on status change.',
            ].join(' '),
            parameters: {
                ledger_path: {
                    type: 'string',
                    description: 'Absolute sandbox path to task_ledger.json',
                    required: true,
                },
                task_id: {
                    type: 'string',
                    description: 'ID of the task to update',
                    required: true,
                },
                status: {
                    type: 'string',
                    description: 'New status: pending, active, or completed',
                    required: false,
                },
                owner: {
                    type: 'string',
                    description: 'Agent taking ownership (include @)',
                    required: false,
                },
                lock: {
                    type: 'string',
                    description: 'Caller handle to acquire lock, or null to release',
                    required: false,
                },
                validation_hash: {
                    type: 'string',
                    description: 'Validation pass hash to record (use on completion)',
                    required: false,
                },
                notes: {
                    type: 'string',
                    description: 'Human-readable notes to record on the task',
                    required: false,
                },
            },
            returns: '{ task: Task, transition?: "from→to" }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'ledger_path'));
                const taskId = requireString(args, 'task_id');
                sandbox.assertWritable(agentPath, callerHandle);

                const { ledger, realPath } = readLedger(sandbox, agentPath);
                const taskIdx = ledger.tasks.findIndex(t => t.id === taskId);
                if (taskIdx === -1) throw new Error(`Task not found: "${taskId}"`);

                const task: LedgerTask = { ...ledger.tasks[taskIdx]! };
                const fromStatus = task.status;
                let transition: string | undefined;

                // ── Lock check ─────────────────────────────────────────
                const currentLock = task.lock ?? null;
                const caller = callerHandle ?? null;
                if (currentLock !== null && currentLock !== caller) {
                    throw new Error(
                        `Task "${taskId}" is locked by ${currentLock}. Only the lock holder can update it.`,
                    );
                }

                // ── Status transition ──────────────────────────────────
                if (typeof args['status'] === 'string') {
                    const toStatus = args['status'];
                    if (!VALID_STATUSES.has(toStatus)) {
                        throw new Error(
                            `Invalid status: "${toStatus}". Must be pending, active, or completed.`,
                        );
                    }
                    const typedTo = toStatus as LedgerTask['status'];
                    if (typedTo !== fromStatus) {
                        const allowed = VALID_TRANSITIONS[fromStatus];
                        if (!allowed.includes(typedTo)) {
                            const allowedStr = allowed.length > 0
                                ? allowed.join(', ')
                                : 'none (terminal state)';
                            throw new Error(
                                `Invalid transition: ${fromStatus} → ${typedTo}. Allowed from ${fromStatus}: [${allowedStr}]`,
                            );
                        }

                        // Dependency gate: all deps must be completed before activation.
                        if (typedTo === 'active') {
                            const completedIds = new Set(
                                ledger.tasks.filter(t => t.status === 'completed').map(t => t.id),
                            );
                            const unmet = (task.dependencies ?? []).filter(dep => !completedIds.has(dep));
                            if (unmet.length > 0) {
                                throw new Error(
                                    `Cannot activate "${taskId}": unmet dependencies: ${unmet.join(', ')}`,
                                );
                            }
                        }

                        task.status = typedTo;
                        transition = `${fromStatus}→${typedTo}`;
                    }
                }

                // ── Apply remaining fields ─────────────────────────────
                if (typeof args['owner'] === 'string')           task.owner = args['owner'];
                if ('lock' in args) {
                    const lv = args['lock'];
                    if (lv !== null && typeof lv !== 'string') {
                        throw new Error('"lock" must be a string or null');
                    }
                    task.lock = lv ?? null;
                }
                if (typeof args['validation_hash'] === 'string') task.validation_hash = args['validation_hash'];
                if (typeof args['notes'] === 'string')           task.notes = args['notes'];

                // ── Write back ─────────────────────────────────────────
                ledger.tasks[taskIdx] = task;
                if (transition) {
                    if (!Array.isArray(ledger.history)) ledger.history = [];
                    ledger.history.push({
                        ts: new Date().toISOString(),
                        task_id: taskId,
                        by: caller ?? 'unknown',
                        from: fromStatus,
                        to: task.status,
                    });
                }

                fs.writeFileSync(realPath, JSON.stringify(ledger, null, 2), 'utf-8');
                return { task, ...(transition !== undefined ? { transition } : {}) };
            },
        };
    }

    // ── ledger/reconcile ────────────────────────────────────────

    private reconcileTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'reconcile',
            description: [
                'Scan a task_ledger.json for illegal states and optionally repair them.',
                'Detects: ORPHAN_ACTIVE (active with no owner), STALE_LOCK (lock on non-active task),',
                'DEP_VIOLATION (completed task has incomplete dep), ACTIVE_BLOCKED (active task has incomplete dep),',
                'DUPLICATE_ID (two tasks share an id).',
                'With repair=true, automatically fixes ORPHAN_ACTIVE (→pending) and STALE_LOCK (clears lock).',
            ].join(' '),
            parameters: {
                ledger_path: {
                    type: 'string',
                    description: 'Absolute sandbox path to task_ledger.json',
                    required: true,
                },
                repair: {
                    type: 'boolean',
                    description: 'If true, automatically fix ORPHAN_ACTIVE and STALE_LOCK violations',
                    required: false,
                },
            },
            returns: '{ status: "clean"|"violations", violations: [{rule, task_id, hint}], repaired: number, summary }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'ledger_path'));
                const repair = args['repair'] === true;
                if (repair) sandbox.assertWritable(agentPath, callerHandle);

                const { ledger, realPath } = readLedger(sandbox, agentPath);
                const violations: ReconcileViolation[] = [];
                let repaired = 0;

                // Build status map for dep lookups.
                const statusMap = new Map<string, LedgerTask['status']>();
                const seenIds = new Set<string>();

                for (const task of ledger.tasks) {
                    // DUPLICATE_ID
                    if (seenIds.has(task.id)) {
                        violations.push({
                            rule: 'DUPLICATE_ID',
                            task_id: task.id,
                            hint: `Task id "${task.id}" appears more than once. Remove or rename the duplicate.`,
                        });
                    }
                    seenIds.add(task.id);
                    statusMap.set(task.id, task.status);
                }

                for (const task of ledger.tasks) {
                    // ORPHAN_ACTIVE: active but no owner.
                    if (task.status === 'active' && !task.owner) {
                        violations.push({
                            rule: 'ORPHAN_ACTIVE',
                            task_id: task.id,
                            hint: `Task is active but has no owner. Assign an owner or reset to pending.`,
                        });
                        if (repair) {
                            task.status = 'pending';
                            repaired++;
                        }
                    }

                    // STALE_LOCK: lock set on a non-active task.
                    if (task.lock && task.status !== 'active') {
                        violations.push({
                            rule: 'STALE_LOCK',
                            task_id: task.id,
                            hint: `Task has lock "${task.lock}" but status is "${task.status}". Clear the lock.`,
                        });
                        if (repair) {
                            task.lock = null;
                            repaired++;
                        }
                    }

                    // Dependency-based checks.
                    for (const depId of (task.dependencies ?? [])) {
                        const depStatus = statusMap.get(depId);
                        if (depStatus === undefined) continue; // dep not in ledger — BROKEN_REF-like, skip here

                        // DEP_VIOLATION: completed task has incomplete dep.
                        if (task.status === 'completed' && depStatus !== 'completed') {
                            violations.push({
                                rule: 'DEP_VIOLATION',
                                task_id: task.id,
                                hint: `Completed task "${task.id}" has dep "${depId}" with status "${depStatus}". Manual review required.`,
                            });
                        }

                        // ACTIVE_BLOCKED: active task has incomplete dep.
                        if (task.status === 'active' && depStatus !== 'completed') {
                            violations.push({
                                rule: 'ACTIVE_BLOCKED',
                                task_id: task.id,
                                hint: `Active task "${task.id}" has dep "${depId}" with status "${depStatus}". Dep must be completed first.`,
                            });
                        }
                    }
                }

                if (repair && repaired > 0) {
                    fs.writeFileSync(realPath, JSON.stringify(ledger, null, 2), 'utf-8');
                }

                return {
                    status: violations.length === 0 ? 'clean' : 'violations',
                    violations,
                    repaired,
                    summary: {
                        tasks_checked: ledger.tasks.length,
                        violations: violations.length,
                        repaired,
                    },
                };
            },
        };
    }
}
