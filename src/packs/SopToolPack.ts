/**
 * SopToolPack — SOP (Standard Operating Procedure) verification tool.
 *
 * Mounts at /tools/sop/ with one tool:
 *
 *   sop/verify  — check whether prerequisites for a SOP task are met in the ledger
 *
 * SOP markdown format expected:
 *   ## Prerequisites
 *   - [ ] Task ID: `task_id` (description)
 *   ...
 *
 * Returns { status: "READY" | "BLOCKED", task_id, reasons[], missing_deps[], expected_state }
 * Replaces per-turn manual SOP + ledger re-reading with a single deterministic call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import type { LedgerTask } from './LedgerToolPack.js';

// ─── Types ───────────────────────────────────────────────────────

type VerifyStatus = 'READY' | 'BLOCKED';

interface LedgerShape {
    tasks: LedgerTask[];
}

import { requireString, normAgentPath } from './pack-helpers.js';

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract prerequisite task IDs from the ## Prerequisites section of a SOP file.
 * Matches lines like: - [ ] Task ID: `some_id` (optional description)
 */
function parsePrerequisites(content: string): string[] {
    // Find the Prerequisites section header.
    const headerRe = /^##\s+Prerequisites\s*$/m;
    const headerMatch = content.match(headerRe);
    if (!headerMatch || headerMatch.index === undefined) return [];

    const headerEnd = headerMatch.index + headerMatch[0].length;
    const rest = content.slice(headerEnd);

    // Body ends at next ## heading or end of string.
    const nextSection = rest.match(/\n(?=##[ \t])/);
    const body = nextSection !== null ? rest.slice(0, nextSection.index) : rest;

    const taskIdRe = /Task ID:\s*`([^`]+)`/g;
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = taskIdRe.exec(body)) !== null) {
        ids.push(m[1]!.trim());
    }
    return ids;
}

function readLedger(sandbox: Sandbox, agentPath: string): LedgerShape {
    const realPath = sandbox.resolveExisting(agentPath);
    const content = fs.readFileSync(realPath, 'utf-8');
    const ledger = JSON.parse(content) as LedgerShape;
    if (!Array.isArray(ledger.tasks)) throw new Error(`Invalid ledger: "tasks" must be an array`);
    return ledger;
}

// ─── SopToolPack ─────────────────────────────────────────────────

export class SopToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('sop', [this.verifyTool()]).createLayer();
    }

    // ── sop/verify ──────────────────────────────────────────────

    private verifyTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'verify',
            description: [
                'Check whether a SOP task is ready to start.',
                'Reads the SOP Prerequisites section and verifies each referenced task ID is',
                '"completed" in the ledger. Also checks the target task is "pending" (not already active).',
                'Returns READY or BLOCKED with structured reasons — no manual SOP re-reading required.',
            ].join(' '),
            parameters: {
                sop_path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the SOP markdown file',
                    required: true,
                },
                ledger_path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the project task_ledger.json',
                    required: true,
                },
                task_id: {
                    type: 'string',
                    description: 'ID of the task the caller intends to start',
                    required: true,
                },
            },
            returns: '{ status: "READY"|"BLOCKED", task_id, reasons: string[], missing_deps: Task[], expected_state: Record }',
            handler: async (args) => {
                const sopPath    = normAgentPath(requireString(args, 'sop_path'));
                const ledgerPath = normAgentPath(requireString(args, 'ledger_path'));
                const taskId     = requireString(args, 'task_id');

                // Read SOP.
                const sopReal = sandbox.resolveExisting(sopPath);
                const sopContent = fs.readFileSync(sopReal, 'utf-8');
                const prereqIds = parsePrerequisites(sopContent);

                // Read ledger.
                const ledger = readLedger(sandbox, ledgerPath);
                const taskMap = new Map(ledger.tasks.map(t => [t.id, t]));

                const reasons: string[] = [];
                const missingDeps: LedgerTask[] = [];

                // Check the target task itself.
                const targetTask = taskMap.get(taskId);
                if (!targetTask) {
                    reasons.push(`Task "${taskId}" not found in ledger.`);
                } else if (targetTask.status === 'active') {
                    reasons.push(`Task "${taskId}" is already active (owner: ${targetTask.owner ?? 'unassigned'}).`);
                } else if (targetTask.status === 'completed') {
                    reasons.push(`Task "${taskId}" is already completed.`);
                }

                // Check prerequisites.
                for (const prereqId of prereqIds) {
                    const prereq = taskMap.get(prereqId);
                    if (!prereq) {
                        reasons.push(`Prerequisite "${prereqId}" not found in ledger.`);
                        missingDeps.push({ id: prereqId, description: '(not in ledger)', status: 'pending' });
                    } else if (prereq.status !== 'completed') {
                        reasons.push(`Prerequisite "${prereqId}" is ${prereq.status}, not completed.`);
                        missingDeps.push(prereq);
                    }
                }

                const status: VerifyStatus = reasons.length === 0 ? 'READY' : 'BLOCKED';
                const expectedState: Record<string, string> = {};
                for (const id of prereqIds) {
                    expectedState[id] = 'completed';
                }
                if (targetTask) {
                    expectedState[taskId] = 'pending';
                }

                return {
                    status,
                    task_id: taskId,
                    reasons,
                    missing_deps: missingDeps,
                    expected_state: expectedState,
                };
            },
        };
    }
}
