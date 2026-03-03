/**
 * SnapshotToolPack — cheap directory checkpointing for review and rollback awareness.
 *
 * Mounts at /tools/snapshot/ with three tools:
 *
 *   snapshot/create  — copy a project directory into /tmp/snapshots/<id>/
 *   snapshot/list    — list all snapshots in /tmp/snapshots/
 *   snapshot/diff    — compare a snapshot to a current directory (added/removed/modified)
 *
 * Snapshots are stored in /tmp/ (scratch space — not index-tracked, may not survive restarts).
 * Use before @nova starts work and after completion so @ivy can review the exact change set.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';

// ─── Types ───────────────────────────────────────────────────────

interface SnapshotMeta {
    id: string;
    source_path: string;
    label?: string;
    created_at: string;
    file_count: number;
}

import { requireString, normAgentPath } from './pack-helpers.js';

// ─── Helpers ─────────────────────────────────────────────────────

/** Generate a sortable, millisecond-unique snapshot id from current timestamp. */
function makeId(): string {
    const d = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `snap_${date}_${time}_${ms}`;
}

/**
 * Recursively copy src → dest, skipping hidden entries.
 * Returns the number of files copied.
 */
function copyDir(src: string, dest: string): number {
    fs.mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            count += copyDir(s, d);
        } else {
            fs.copyFileSync(s, d);
            count++;
        }
    }
    return count;
}

/**
 * Walk a directory tree, yielding agent-visible relative paths for all files.
 * Skips hidden entries.
 */
function* walkFiles(dir: string, rel = ''): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkFiles(fullPath, relPath);
        } else {
            yield relPath;
        }
    }
}

// ─── SnapshotToolPack ────────────────────────────────────────────

export class SnapshotToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('snapshot', [
            this.createTool(),
            this.listTool(),
            this.diffTool(),
        ]).createLayer();
    }

    // ── snapshot/create ─────────────────────────────────────────

    private createTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'create',
            description: [
                'Checkpoint a sandbox directory into /tmp/snapshots/<id>/.',
                'Use before starting work on a project to capture the baseline.',
                'Snapshots are scratch-space — not index-tracked and may not persist across restarts.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path of directory to snapshot (e.g. /data/projects/myproject)',
                    required: true,
                },
                label: {
                    type: 'string',
                    description: 'Optional human-readable label (e.g. "before-refactor")',
                    required: false,
                },
            },
            returns: '{ id, snapshot_path, source_path, label?, created_at, file_count }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const label = typeof args['label'] === 'string' ? args['label'] : undefined;

                const realSrc = sandbox.resolveExisting(agentPath);
                if (!fs.statSync(realSrc).isDirectory()) {
                    throw new Error(`Path must be a directory: ${agentPath}`);
                }

                const id = makeId();
                const snapshotRoot = path.join(sandbox.root, 'tmp', 'snapshots', id);
                const dataDir = path.join(snapshotRoot, 'data');

                const fileCount = copyDir(realSrc, dataDir);

                const meta: SnapshotMeta = {
                    id,
                    source_path: agentPath,
                    ...(label !== undefined ? { label } : {}),
                    created_at: new Date().toISOString(),
                    file_count: fileCount,
                };
                fs.writeFileSync(
                    path.join(snapshotRoot, 'meta.json'),
                    JSON.stringify(meta, null, 2),
                    'utf-8',
                );

                return {
                    ...meta,
                    snapshot_path: `/tmp/snapshots/${id}`,
                };
            },
        };
    }

    // ── snapshot/list ───────────────────────────────────────────

    private listTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'list',
            description: 'List all available snapshots in /tmp/snapshots/, newest first.',
            parameters: {},
            returns: '{ snapshots: SnapshotMeta[], count: number }',
            handler: async () => {
                const snapshotsRoot = path.join(sandbox.root, 'tmp', 'snapshots');
                if (!fs.existsSync(snapshotsRoot)) {
                    return { snapshots: [], count: 0 };
                }

                const snapshots: SnapshotMeta[] = [];
                for (const entry of fs.readdirSync(snapshotsRoot, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    const metaPath = path.join(snapshotsRoot, entry.name, 'meta.json');
                    if (!fs.existsSync(metaPath)) continue;
                    try {
                        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
                        snapshots.push(meta);
                    } catch { /* skip malformed */ }
                }

                // Newest first (IDs are timestamp-based, so reverse-sort works).
                snapshots.sort((a, b) => b.id.localeCompare(a.id));
                return { snapshots, count: snapshots.length };
            },
        };
    }

    // ── snapshot/diff ───────────────────────────────────────────

    private diffTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'diff',
            description: [
                'Compare a snapshot to a current directory.',
                'Returns lists of added, removed, and modified files.',
                'Modified files include a unified diff of their content changes.',
                'Use after work is complete to produce a structured change set for review.',
            ].join(' '),
            parameters: {
                id: {
                    type: 'string',
                    description: 'Snapshot ID returned by snapshot/create (e.g. snap_20260303_142501_123)',
                    required: true,
                },
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path of the current directory to compare against the snapshot (defaults to the snapshot\'s original source_path)',
                    required: false,
                },
            },
            returns: '{ id, added[], removed[], modified[{path, diff}], unchanged: number, source_path }',
            handler: async (args) => {
                const id = requireString(args, 'id');

                const snapshotRoot = path.join(sandbox.root, 'tmp', 'snapshots', id);
                if (!fs.existsSync(snapshotRoot)) {
                    throw new Error(`Snapshot not found: "${id}". Run snapshot/list to see available snapshots.`);
                }
                const metaPath = path.join(snapshotRoot, 'meta.json');
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SnapshotMeta;

                // Determine the current directory to compare.
                const currentAgentPath = typeof args['path'] === 'string'
                    ? normAgentPath(args['path'])
                    : meta.source_path;

                const realCurrent = sandbox.resolveExisting(currentAgentPath);
                if (!fs.statSync(realCurrent).isDirectory()) {
                    throw new Error(`Path must be a directory: ${currentAgentPath}`);
                }

                const snapshotData = path.join(snapshotRoot, 'data');

                // Build file maps.
                const snapFiles = new Map<string, string>(); // relPath → realPath
                if (fs.existsSync(snapshotData)) {
                    for (const rel of walkFiles(snapshotData)) {
                        snapFiles.set(rel, path.join(snapshotData, rel));
                    }
                }

                const currFiles = new Map<string, string>();
                for (const rel of walkFiles(realCurrent)) {
                    currFiles.set(rel, path.join(realCurrent, rel));
                }

                const added: string[] = [];
                const removed: string[] = [];
                const modified: Array<{ path: string; diff: string }> = [];
                let unchanged = 0;

                // Files in current but not in snapshot → added.
                for (const [rel] of currFiles) {
                    if (!snapFiles.has(rel)) added.push(rel);
                }

                // Files in snapshot: removed or potentially modified.
                for (const [rel, snapReal] of snapFiles) {
                    if (!currFiles.has(rel)) {
                        removed.push(rel);
                        continue;
                    }
                    const currReal = currFiles.get(rel)!;
                    const snapContent = fs.readFileSync(snapReal, 'utf-8');
                    const currContent = fs.readFileSync(currReal, 'utf-8');
                    if (snapContent === currContent) {
                        unchanged++;
                    } else {
                        const diff = createTwoFilesPatch(
                            `snapshot/${rel}`,
                            `current/${rel}`,
                            snapContent,
                            currContent,
                        );
                        modified.push({ path: rel, diff });
                    }
                }

                return {
                    id,
                    source_path: currentAgentPath,
                    added,
                    removed,
                    modified,
                    unchanged,
                };
            },
        };
    }
}
