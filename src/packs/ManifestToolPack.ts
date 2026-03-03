/**
 * ManifestToolPack — lightweight index.md registration check.
 *
 * Mounts at /tools/manifest/ with one tool:
 *
 *   manifest/check  — verify a file/dir name appears in its parent directory's index.md
 *
 * Lighter than validate/run: single-path, synchronous, zero tree traversal.
 * Use inline after any write to catch MANIFEST_UNDOC before it accumulates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString, normAgentPath, globToRegex } from './pack-helpers.js';

/**
 * Find whether `name` is documented in `content`.
 * Returns the 1-based line number for an exact match, 0 for a glob match, -1 if not found.
 */
function findInIndex(name: string, content: string): number {
    const withSlash = `${name}/`;
    const lines = content.split('\n');
    // Exact match — report line number.
    const exactLine = lines.findIndex(
        line => line.includes(`\`${name}\``) || line.includes(`\`${withSlash}\``)
            || line.includes(`[${name}]`) || line.includes(`[${withSlash}]`),
    );
    if (exactLine !== -1) return exactLine + 1;
    // Glob match — no specific line.
    const tokenRe = /`([^`]*\*[^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(content)) !== null) {
        const patternBase = m[1]!.endsWith('/') ? m[1]!.slice(0, -1) : m[1]!;
        if (globToRegex(patternBase).test(name)) return 0;
    }
    return -1;
}

// ─── ManifestToolPack ────────────────────────────────────────────

export class ManifestToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('manifest', [this.checkTool()]).createLayer();
    }

    // ── manifest/check ──────────────────────────────────────────

    private checkTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'check',
            description: [
                'Check whether a file or directory is documented in its parent directory\'s index.md.',
                'Call immediately after creating or moving any file to catch MANIFEST_UNDOC before it accumulates.',
                'Much cheaper than validate/run — single-file check, no tree traversal.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path of the file or directory to check (e.g. /home/nova/notes.md)',
                    required: true,
                },
            },
            returns: '{ registered: boolean, name: string, parent_index: string, line?: number, via_glob?: boolean }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));

                // Derive the parent directory and target name.
                const parentAgentPath = path.dirname(agentPath);
                const name = path.basename(agentPath);
                const parentIndexAgentPath = path.join(parentAgentPath, 'index.md');

                // Resolve parent index (it may not exist).
                let indexContent: string | null = null;
                try {
                    const indexReal = sandbox.resolveExisting(parentIndexAgentPath);
                    indexContent = fs.readFileSync(indexReal, 'utf-8');
                } catch {
                    // Parent index doesn't exist — not registered by definition.
                }

                if (indexContent === null) {
                    return {
                        registered: false,
                        name,
                        parent_index: parentIndexAgentPath,
                        reason: 'Parent index.md does not exist.',
                    };
                }

                // Search for the name: exact match (returns line) or glob match (returns via_glob).
                const result = findInIndex(name, indexContent);
                return {
                    registered: result !== -1,
                    name,
                    parent_index: parentIndexAgentPath,
                    ...(result > 0  ? { line: result } : {}),
                    ...(result === 0 ? { via_glob: true } : {}),
                };
            },
        };
    }
}
