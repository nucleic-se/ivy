/**
 * IndexToolPack — index.md maintenance tools.
 *
 * Mounts at /tools/index/ with two tools:
 *
 *   index/write    — write a file and register it in the parent index.md atomically.
 *                    Replaces the write-then-refresh two-step with a single operation.
 *
 *   index/refresh  — scan a directory and add stub entries to index.md for any
 *                    undocumented files or subdirectories.
 *
 * Only adds missing entries — never removes or rewrites existing content.
 * Use after creating new files to keep index.md current without manual editing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString, normAgentPath, isDocumentedInIndex } from './pack-helpers.js';

// ─── Constants ───────────────────────────────────────────────────

/** Entries always exempt from MANIFEST_UNDOC — self-managed or trivially self-referential. */
const EXEMPT = new Set(['index.md']);

// ─── IndexToolPack ───────────────────────────────────────────────

export class IndexToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('index', [this.writeTool(), this.refreshTool()]).createLayer();
    }

    // ── index/write ──────────────────────────────────────────────

    private writeTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'write',
            description: [
                'Write a file and register it in the parent directory\'s index.md in one atomic operation.',
                'If the file name is already documented in index.md, the file is still written but no duplicate entry is added.',
                'Creates index.md if it does not exist.',
                'Prefer this over text/write + index/refresh for new files that need a real description.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute agent path of the file to write.',
                    required: true,
                },
                content: {
                    type: 'string',
                    description: 'Full content to write to the file.',
                    required: true,
                },
                description: {
                    type: 'string',
                    description: 'One-line description for the index.md entry.',
                    required: true,
                },
            },
            returns: '{ written: true, registered: boolean, index_path: string }',
            handler: async (args, callerHandle) => {
                const agentFilePath = normAgentPath(requireString(args, 'path'));
                const content = requireString(args, 'content');
                const description = requireString(args, 'description');

                const name = path.basename(agentFilePath);
                if (name === 'index.md') {
                    throw new Error('Use text/write to write index.md directly');
                }

                // Write the file.
                sandbox.assertWritable(agentFilePath, callerHandle);
                const realFilePath = sandbox.resolveForWrite(agentFilePath);
                fs.mkdirSync(path.dirname(realFilePath), { recursive: true });
                fs.writeFileSync(realFilePath, content, 'utf8');

                // Register in parent index.md.
                const agentDirPath = path.dirname(agentFilePath);
                const agentIndexPath = `${agentDirPath}/index.md`;

                let existingContent = '';
                try {
                    const realIndexPath = sandbox.resolveExisting(agentIndexPath);
                    existingContent = fs.readFileSync(realIndexPath, 'utf8');
                } catch {
                    // index.md doesn't exist yet — will be created.
                }

                if (isDocumentedInIndex(name, false, existingContent)) {
                    return { written: true, registered: false, index_path: agentIndexPath };
                }

                sandbox.assertWritable(agentIndexPath, callerHandle);
                const realIndexPath = sandbox.resolveForWrite(agentIndexPath);
                const separator = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
                fs.mkdirSync(path.dirname(realIndexPath), { recursive: true });
                fs.appendFileSync(realIndexPath, `${separator}- \`${name}\`: ${description}\n`, 'utf8');

                return { written: true, registered: true, index_path: agentIndexPath };
            },
        };
    }

    // ── index/refresh ────────────────────────────────────────────

    private refreshTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'refresh',
            description: [
                'Scan a directory and add stub entries to its index.md for any undocumented items.',
                'Only adds missing entries — never removes or modifies existing content.',
                'Creates index.md if it does not exist.',
                'Use after writing new files to prevent MANIFEST_UNDOC violations.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute agent path to the directory to refresh.',
                    required: true,
                },
            },
            returns: '{ added: string[], unchanged: number, index_path: string }',
            handler: async (args, callerHandle) => {
                const agentDirPath = normAgentPath(requireString(args, 'path'));
                const realDirPath = sandbox.resolveExisting(agentDirPath);

                // Must be a directory.
                const stat = fs.statSync(realDirPath);
                if (!stat.isDirectory()) {
                    throw new Error(`"${agentDirPath}" is not a directory`);
                }

                // Agent index path.
                const agentIndexPath = agentDirPath.endsWith('/')
                    ? `${agentDirPath}index.md`
                    : `${agentDirPath}/index.md`;

                // Read existing index.md content (empty string if it doesn't exist yet).
                let existingContent = '';
                try {
                    const realIndexPath = sandbox.resolveExisting(agentIndexPath);
                    existingContent = fs.readFileSync(realIndexPath, 'utf8');
                } catch {
                    // index.md doesn't exist — will be created.
                }

                // Scan directory for undocumented items.
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(realDirPath, { withFileTypes: true });
                } catch {
                    throw new Error(`Cannot read directory: ${agentDirPath}`);
                }

                const missing: string[] = [];
                let unchanged = 0;

                for (const e of entries) {
                    if (e.name.startsWith('.')) continue;
                    if (EXEMPT.has(e.name)) continue;
                    if (isDocumentedInIndex(e.name, e.isDirectory(), existingContent)) {
                        unchanged++;
                    } else {
                        missing.push(e.name);
                    }
                }

                if (missing.length === 0) {
                    return { added: [], unchanged, index_path: agentIndexPath };
                }

                // Build stub entries for missing items.
                const stubs = missing.map(name => {
                    const isDir = entries.find(e => e.name === name)?.isDirectory() ?? false;
                    const label = isDir ? `${name}/` : name;
                    return `- \`${label}\`: (undocumented — please add a description)`;
                });

                // Append to index.md (create if needed).
                sandbox.assertWritable(agentIndexPath, callerHandle);
                const realIndexPath = sandbox.resolveForWrite(agentIndexPath);

                const separator = existingContent.length > 0 && !existingContent.endsWith('\n')
                    ? '\n'
                    : '';
                const appended = `${separator}${stubs.join('\n')}\n`;

                fs.mkdirSync(path.dirname(realIndexPath), { recursive: true });
                fs.appendFileSync(realIndexPath, appended, 'utf8');

                return { added: missing, unchanged, index_path: agentIndexPath };
            },
        };
    }
}
