/**
 * FsToolPack — file-system tools for sandbox agents.
 *
 * Mounts a virtual tool group at /tools/fs/ with:
 *
 *   fs/diff  — compare two sandbox files; returns a unified diff string
 *   fs/rm    — delete a file or directory (recursive opt-in)
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
import { requireString, normAgentPath } from './pack-helpers.js';
import { MAX_SANDBOX_FILE_BYTES } from '../constants.js';

// ─── Constants ───────────────────────────────────────────────────

const MAX_FILE_BYTES = MAX_SANDBOX_FILE_BYTES;

// ─── FsToolPack ──────────────────────────────────────────────────

export class FsToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('fs', [
            this.diffTool(),
            this.rmTool(),
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

    // ── fs/rm ────────────────────────────────────────────────────

    private rmTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'rm',
            description: [
                'Delete a file or directory from the sandbox.',
                'By default only removes files and empty directories.',
                'Set recursive: true to remove a directory and all its contents.',
                'Protected paths (/, /home, /tools, /data, /tmp) and cross-agent home paths cannot be deleted.',
            ].join(' '),
            parameters: {
                path:      { type: 'string',  description: 'Absolute sandbox path to delete', required: true },
                recursive: { type: 'boolean', description: 'If true, recursively delete directory contents (default false)', required: false },
            },
            returns: 'string — confirmation message',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const recursive = args['recursive'] === true;
                return sandbox.execFs({ type: 'fs', op: 'rm', path: agentPath, recursive }, callerHandle);
            },
        };
    }
}
