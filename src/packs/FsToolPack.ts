/**
 * FsToolPack — file-system comparison tools for sandbox agents.
 *
 * Mounts a virtual tool group at /tools/fs/ with one tool:
 *
 *   fs/diff  — compare two sandbox files; returns a unified diff string
 *
 * All paths are agent-visible absolute paths (e.g. "/home/notes.md").
 * Security enforcement is delegated to the Sandbox instance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';

// ─── Constants ───────────────────────────────────────────────────

const MAX_FILE_BYTES = 512 * 1024; // 512 KB per file

// ─── Argument helpers ────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
    return v;
}

function normAgentPath(raw: string): string {
    const p = path.normalize(raw);
    if (!path.isAbsolute(p)) throw new Error(`Path must be absolute, got: ${raw}`);
    return p;
}

// ─── FsToolPack ──────────────────────────────────────────────────

export class FsToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('fs', [
            this.diffTool(),
        ]).createLayer();
    }

    // ── fs/diff ─────────────────────────────────────────────────

    private diffTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'diff',
            description: [
                'Compare two sandbox files and return a unified diff.',
                'Use this to inspect changes before applying them with text/patch.',
                'Pass the result directly to text/patch to apply the diff.',
            ].join(' '),
            parameters: {
                from: { type: 'string', description: 'Absolute sandbox path of the original file', required: true },
                to:   { type: 'string', description: 'Absolute sandbox path of the modified file', required: true },
            },
            returns: '{ diff: string, from, to }',
            handler: async (args) => {
                const fromPath = normAgentPath(requireString(args, 'from'));
                const toPath   = normAgentPath(requireString(args, 'to'));

                const fromReal = sandbox.resolveExisting(fromPath);
                const toReal   = sandbox.resolveExisting(toPath);

                const fromStat = fs.statSync(fromReal);
                const toStat   = fs.statSync(toReal);

                if (fromStat.isDirectory()) throw new Error(`"from" is a directory: ${fromPath}`);
                if (toStat.isDirectory())   throw new Error(`"to" is a directory: ${toPath}`);
                if (fromStat.size > MAX_FILE_BYTES) throw new Error(`"from" too large: ${fromPath}`);
                if (toStat.size > MAX_FILE_BYTES)   throw new Error(`"to" too large: ${toPath}`);

                const fromContent = fs.readFileSync(fromReal, 'utf-8');
                const toContent   = fs.readFileSync(toReal, 'utf-8');

                const diff = createTwoFilesPatch(fromPath, toPath, fromContent, toContent);

                return { diff, from: fromPath, to: toPath };
            },
        };
    }
}
