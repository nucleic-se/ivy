/**
 * ContextToolPack — CONTEXT.md maintenance tools for sandbox agents.
 *
 * Mounts at /tools/context/ with one tool:
 *
 *   context/compact  — trim the Recent Updates section to at most max entries (default 5)
 *
 * Entries are assumed ordered newest-first; oldest entries at the bottom are pruned.
 * The tool is a no-op when the section already has ≤ max entries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString, normAgentPath } from './pack-helpers.js';

/**
 * Count bullet entries per named section in a CONTEXT.md-style file.
 * Section headings: "## Heading" or "Heading:" at the start of a line.
 * Counted entries: lines beginning with optional whitespace then "- " or "* ".
 */
function parseSectionSizes(content: string): Record<string, number> {
    const sizes: Record<string, number> = {};
    let current: string | null = null;
    for (const raw of content.split('\n')) {
        const line = raw.trimEnd();
        const h2 = line.match(/^##\s+(.+)/);
        const colon =
            !line.startsWith(' ') && !line.startsWith('\t')
                ? line.match(/^([A-Z][A-Za-z ]+):\s*$/)
                : null;
        if (h2) {
            current = h2[1]!.trim();
            sizes[current] ??= 0;
        } else if (colon) {
            current = colon[1]!.trim();
            sizes[current] ??= 0;
        } else if (current && /^[ \t]*[-*] /.test(line)) {
            sizes[current]++;
        }
    }
    return sizes;
}

/**
 * Locate the "Recent Updates" section and trim it to at most `max` bullet entries.
 * Supports both "## Recent Updates" and "Recent Updates:" as section headers.
 * Returns the modified content and the number of entries pruned.
 */
function compactRecentUpdates(
    content: string,
    max: number,
): { newContent: string; pruned_count: number } {
    const headerRe = /^(##\s+Recent Updates|Recent Updates:)\s*$/m;
    const headerMatch = content.match(headerRe);
    if (!headerMatch || headerMatch.index === undefined) {
        return { newContent: content, pruned_count: 0 };
    }

    const sectionStart = headerMatch.index;
    const headerEnd = sectionStart + headerMatch[0].length;

    // Body ends at the next section heading (## style or Uppercase-Word: style) or at end of string.
    const rest = content.slice(headerEnd);
    const nextSection = rest.match(/\n(?=##[ \t]|[A-Z][A-Za-z ]*:)/);
    const bodyEnd = nextSection !== null ? headerEnd + nextSection.index! : content.length;

    const body = content.slice(headerEnd, bodyEnd);
    const bulletLines = body.split('\n').filter(l => /^[ \t]*[-*] /.test(l));

    if (bulletLines.length <= max) {
        return { newContent: content, pruned_count: 0 };
    }

    const kept = bulletLines.slice(0, max);
    const pruned_count = bulletLines.length - max;
    const newBody = '\n' + kept.join('\n') + '\n';

    const newContent =
        content.slice(0, sectionStart) +
        headerMatch[0] +
        newBody +
        content.slice(bodyEnd);

    return { newContent, pruned_count };
}

// ─── ContextToolPack ─────────────────────────────────────────────

export class ContextToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('context', [
            this.compactTool(),
        ]).createLayer();
    }

    // ── context/compact ──────────────────────────────────────────

    private compactTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'compact',
            description: [
                'Trim the "Recent Updates" section of a CONTEXT.md to at most max entries (default 5).',
                'Entries are assumed ordered newest-first; oldest entries at the bottom are removed.',
                'No-op when the section already has ≤ max entries.',
                'Returns { compacted, pruned_count, section_sizes }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the CONTEXT.md file (e.g. /home/nova/CONTEXT.md)',
                    required: true,
                },
                max: {
                    type: 'number',
                    description: 'Maximum Recent Updates entries to keep (default 5, minimum 1)',
                    required: false,
                },
            },
            returns: '{ compacted: boolean, pruned_count: number, section_sizes: Record<string, number> }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const max =
                    typeof args['max'] === 'number'
                        ? Math.max(1, Math.floor(args['max']))
                        : 5;

                const realPath = sandbox.resolveExisting(agentPath);
                const content = fs.readFileSync(realPath, 'utf-8');

                const { newContent, pruned_count } = compactRecentUpdates(content, max);

                if (pruned_count > 0) {
                    sandbox.assertWritable(agentPath, callerHandle);
                    fs.writeFileSync(realPath, newContent, 'utf-8');
                }

                const section_sizes = parseSectionSizes(pruned_count > 0 ? newContent : content);
                return {
                    compacted: pruned_count > 0,
                    pruned_count,
                    section_sizes,
                };
            },
        };
    }
}
