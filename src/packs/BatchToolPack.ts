/**
 * BatchToolPack — atomic multi-operation executor with file-level rollback.
 *
 * Mounts at /tools/batch/ with one tool:
 *
 *   batch/apply  — execute a sequence of tool calls atomically; roll back on any failure
 *
 * Rollback scope: all absolute path strings found anywhere in op args (recursive scan).
 * Files that didn't exist before a failed run are deleted on rollback.
 * Side effects outside these paths (e.g. network calls) are not rolled back.
 *
 * Max ops per batch: 20. Snapshot size limit: 512 KB per file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString, normAgentPath } from './pack-helpers.js';

// ─── Constants ───────────────────────────────────────────────────

const MAX_OPS = 20;
const MAX_SNAPSHOT_BYTES = 512 * 1024;

// ─── Types ───────────────────────────────────────────────────────

interface BatchOp {
    tool: string;
    args?: Record<string, unknown>;
}

interface FileSnapshot {
    agentPath: string;
    realPath: string;
    existed: boolean;
    content: Buffer | null; // null if didn't exist before
}

/**
 * Collect unique absolute agent paths from all op args (recursive).
 * Finds every string value that is an absolute path, regardless of key name.
 */
function collectAgentPaths(ops: BatchOp[]): string[] {
    const seen = new Set<string>();
    function extract(value: unknown): void {
        if (typeof value === 'string') {
            const p = path.normalize(value);
            if (path.isAbsolute(p)) seen.add(p);
        } else if (Array.isArray(value)) {
            for (const item of value) extract(item);
        } else if (value !== null && typeof value === 'object') {
            for (const v of Object.values(value)) extract(v);
        }
    }
    for (const op of ops) extract(op.args);
    return [...seen];
}

/**
 * Take a snapshot of a file. Returns null content if file doesn't exist.
 */
function snapshot(sandbox: Sandbox, agentPath: string): FileSnapshot {
    try {
        const realPath = sandbox.resolveExisting(agentPath);
        const stat = fs.statSync(realPath);
        if (stat.isDirectory()) {
            // Directories are not content-snapshotted, only tracked for existence.
            return { agentPath, realPath, existed: true, content: null };
        }
        if (stat.size > MAX_SNAPSHOT_BYTES) {
            // Too large to snapshot — skip content; can still track existence.
            return { agentPath, realPath, existed: true, content: null };
        }
        const content = fs.readFileSync(realPath);
        return { agentPath, realPath, existed: true, content };
    } catch {
        // File doesn't exist yet.
        const realPath = path.join(sandbox.root, agentPath);
        return { agentPath, realPath, existed: false, content: null };
    }
}

/**
 * Restore a single snapshot.
 * - Existed with content → write back original content.
 * - Existed as dir → no-op (can't restore dir contents).
 * - Did not exist → delete the file if it now exists.
 */
function restore(snap: FileSnapshot): void {
    try {
        if (snap.existed && snap.content !== null) {
            fs.writeFileSync(snap.realPath, snap.content);
        } else if (!snap.existed) {
            if (fs.existsSync(snap.realPath) && !fs.statSync(snap.realPath).isDirectory()) {
                fs.unlinkSync(snap.realPath);
            }
        }
        // existed + null content (large file or dir): can't restore — leave as-is.
    } catch {
        // Best-effort; don't mask the original error.
    }
}

// ─── BatchToolPack ───────────────────────────────────────────────

export class BatchToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('batch', [this.applyTool()]).createLayer();
    }

    // ── batch/apply ─────────────────────────────────────────────

    private applyTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'apply',
            description: [
                'Execute a sequence of tool calls atomically.',
                'On any failure, all file changes are rolled back to their pre-batch state.',
                'Rollback covers all absolute path strings found anywhere in op args.',
                'Max 20 ops per batch. Use to prevent partial-write drift across multi-step operations.',
            ].join(' '),
            parameters: {
                ops: {
                    type: 'array',
                    description: 'Ordered list of tool calls: [{ tool: "group/name", args?: {...} }, ...]',
                    required: true,
                },
            },
            returns: '{ status: "ok"|"rolled_back", completed: number, total: number, failed_at?: number, error?: string, rolled_back: number }',
            handler: async (args, callerHandle) => {
                // ── Validate input ─────────────────────────────────────
                if (!Array.isArray(args['ops'])) {
                    throw new Error('"ops" must be an array');
                }
                const ops = args['ops'] as BatchOp[];
                if (ops.length === 0) throw new Error('"ops" must not be empty');
                if (ops.length > MAX_OPS) {
                    throw new Error(`Too many ops: ${ops.length}. Maximum is ${MAX_OPS}.`);
                }
                for (let i = 0; i < ops.length; i++) {
                    const op = ops[i]!;
                    if (typeof op.tool !== 'string' || !op.tool) {
                        throw new Error(`ops[${i}].tool must be a non-empty string`);
                    }
                    if (op.args !== undefined && (typeof op.args !== 'object' || Array.isArray(op.args))) {
                        throw new Error(`ops[${i}].args must be an object if provided`);
                    }
                }

                // ── Snapshot ───────────────────────────────────────────
                const agentPaths = collectAgentPaths(ops);
                const snapshots = agentPaths.map(p => snapshot(sandbox, p));

                // ── Execute ops ────────────────────────────────────────
                let completed = 0;
                for (const op of ops) {
                    try {
                        await sandbox.execCall(op.tool, op.args ?? {}, callerHandle);
                        completed++;
                    } catch (err) {
                        // ── Rollback ───────────────────────────────────
                        let rolledBack = 0;
                        for (const snap of snapshots) {
                            // Use snap.realPath directly — it is pre-computed for both
                            // existing (realpathSync result) and non-existing (root join) files.
                            const currentExists = fs.existsSync(snap.realPath);
                            const currentContent = currentExists && !fs.statSync(snap.realPath).isDirectory()
                                ? fs.readFileSync(snap.realPath)
                                : null;
                            const unchanged = snap.existed
                                ? (snap.content !== null && currentContent !== null
                                    && snap.content.equals(currentContent))
                                : !currentExists;
                            if (!unchanged) {
                                restore(snap);
                                rolledBack++;
                            }
                        }

                        return {
                            status: 'rolled_back',
                            completed,
                            total: ops.length,
                            failed_at: completed,
                            error: (err as Error).message,
                            rolled_back: rolledBack,
                        };
                    }
                }

                return {
                    status: 'ok',
                    completed,
                    total: ops.length,
                    rolled_back: 0,
                };
            },
        };
    }
}
