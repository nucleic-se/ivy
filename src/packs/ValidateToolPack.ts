/**
 * ValidateToolPack — compliance validation tool for sandbox agents.
 *
 * Mounts a virtual tool group at /tools/validate/ with one tool:
 *
 *   validate/run  — run compliance checks on a sandbox path; return structured pass/fail report
 *
 * Checks:
 *   INDEX_MISSING  — a directory has no index.md
 *   MANIFEST_DEAD  — index.md links to a file that does not exist
 *   MANIFEST_UNDOC — a file/dir exists in a directory but its name is absent from index.md
 *   BROKEN_REF     — a non-index .md file contains a relative link to a non-existent target
 *   CONTEXT_SCHEMA — a CONTEXT.md file is missing one or more required sections
 *
 * All paths in output are agent-visible absolute paths (e.g. "/home/nova/CONTEXT.md").
 * Security is delegated to the Sandbox instance for path resolution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';

// ─── Types ───────────────────────────────────────────────────────

type RuleId =
    | 'INDEX_MISSING'   // directory lacks index.md
    | 'MANIFEST_DEAD'   // index.md links to a non-existent file
    | 'MANIFEST_UNDOC'  // file/dir exists but its name is absent from index.md
    | 'BROKEN_REF'      // non-index .md file links to a non-existent target
    | 'CONTEXT_SCHEMA'; // CONTEXT.md is missing a required section

interface Violation {
    rule: RuleId;
    path: string;
    hint: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Sections that every CONTEXT.md must contain (substring match). */
const CONTEXT_REQUIRED = [
    'Active Project',
    'Current Task',
    'Current Protocols',
    'Mini Checklist',
    'Open Questions',
    'Recent Updates',
];

/** Directory names skipped entirely during traversal. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Files exempt from MANIFEST_UNDOC (trivially self-referential or system-managed). */
const EXEMPT_FROM_UNDOC = new Set(['index.md']);

/** Hard limit on total entries scanned per run. */
const MAX_ENTRIES = 2_000;

// ─── Helpers ─────────────────────────────────────────────────────

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

function toAgentPath(realPath: string, sandboxRoot: string): string {
    return realPath.slice(sandboxRoot.length) || '/';
}

function agentIndexPath(dirReal: string, sandboxRoot: string): string {
    const agentDir = toAgentPath(dirReal, sandboxRoot);
    return `${agentDir === '/' ? '' : agentDir}/index.md`;
}

/**
 * Walk a directory tree yielding every entry (file or dir).
 * Skips hidden entries and dirs listed in SKIP_DIRS.
 */
function* walkTree(
    dirReal: string,
): Generator<{ real: string; isDir: boolean; name: string }> {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dirReal, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(e.name)) continue;
        const child = path.join(dirReal, e.name);
        const isDir = e.isDirectory();
        yield { real: child, isDir, name: e.name };
        if (isDir) yield* walkTree(child);
    }
}

/**
 * Extract relative markdown link targets from file content.
 * Strips fragments (#section) and skips external/mailto links.
 */
function extractMarkdownLinks(content: string): string[] {
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    const links: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const href = m[1]!.trim().split('#')[0]!;
        if (!href) continue;
        if (href.startsWith('http') || href.startsWith('mailto:')) continue;
        links.push(href);
    }
    return links;
}

// ─── Check functions ─────────────────────────────────────────────

function checkIndexMissing(
    dirReal: string,
    sandboxRoot: string,
    violations: Violation[],
): void {
    if (!fs.existsSync(path.join(dirReal, 'index.md'))) {
        const agentPath = toAgentPath(dirReal, sandboxRoot);
        violations.push({
            rule: 'INDEX_MISSING',
            path: agentPath,
            hint: `Create index.md in ${agentPath}`,
        });
    }
}

function checkManifest(
    dirReal: string,
    sandboxRoot: string,
    violations: Violation[],
): void {
    const indexReal = path.join(dirReal, 'index.md');
    if (!fs.existsSync(indexReal)) return; // INDEX_MISSING already reported

    let content: string;
    try { content = fs.readFileSync(indexReal, 'utf-8'); }
    catch { return; }

    const agentIndex = agentIndexPath(dirReal, sandboxRoot);

    // MANIFEST_DEAD: every markdown link in this index.md must resolve.
    for (const link of extractMarkdownLinks(content)) {
        const targetReal = path.resolve(dirReal, link);
        if (!targetReal.startsWith(sandboxRoot + '/')) continue; // external — skip
        if (!fs.existsSync(targetReal)) {
            violations.push({
                rule: 'MANIFEST_DEAD',
                path: agentIndex,
                hint: `Link "${link}" resolves to a non-existent target. Remove or fix.`,
            });
        }
    }

    // MANIFEST_UNDOC: every file/dir in this directory must be mentioned in index.md.
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dirReal, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (EXEMPT_FROM_UNDOC.has(e.name)) continue;
        if (!content.includes(e.name)) {
            const agentDir = toAgentPath(dirReal, sandboxRoot);
            const entryAgent = `${agentDir === '/' ? '' : agentDir}/${e.name}${e.isDirectory() ? '/' : ''}`;
            violations.push({
                rule: 'MANIFEST_UNDOC',
                path: entryAgent,
                hint: `"${e.name}" is not mentioned in ${agentIndex}. Add an entry.`,
            });
        }
    }
}

function checkBrokenRefs(
    fileReal: string,
    sandboxRoot: string,
    violations: Violation[],
): void {
    let content: string;
    try { content = fs.readFileSync(fileReal, 'utf-8'); }
    catch { return; }

    const agentPath = toAgentPath(fileReal, sandboxRoot);
    const dir = path.dirname(fileReal);

    for (const link of extractMarkdownLinks(content)) {
        const targetReal = path.resolve(dir, link);
        if (!targetReal.startsWith(sandboxRoot + '/')) continue;
        if (!fs.existsSync(targetReal)) {
            violations.push({
                rule: 'BROKEN_REF',
                path: agentPath,
                hint: `Link "${link}" resolves to a non-existent target.`,
            });
        }
    }
}

function checkContextSchema(
    fileReal: string,
    sandboxRoot: string,
    violations: Violation[],
): void {
    let content: string;
    try { content = fs.readFileSync(fileReal, 'utf-8'); }
    catch { return; }

    const agentPath = toAgentPath(fileReal, sandboxRoot);
    const missing = CONTEXT_REQUIRED.filter(s => !content.includes(s));

    if (missing.length > 0) {
        violations.push({
            rule: 'CONTEXT_SCHEMA',
            path: agentPath,
            hint: `Missing section(s): ${missing.map(s => `"${s}"`).join(', ')}. See /data/protocols/MEMORY.md.`,
        });
    }
}

// ─── ValidateToolPack ────────────────────────────────────────────

export class ValidateToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('validate', [this.runTool()]).createLayer();
    }

    // ── validate/run ────────────────────────────────────────────

    private runTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'run',
            description: [
                'Run compliance checks on a sandbox path.',
                'Returns a structured pass/fail report with exact violations (rule, path, fix hint).',
                'Checks: index (every dir has index.md), manifest (links valid + files documented),',
                'refs (no broken links in .md files), context (CONTEXT.md schema compliance).',
                'Required before any task close or review submission.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to validate (e.g. /data/projects/myproject, /home/nova, or / for full workspace)',
                    required: true,
                },
                checks: {
                    type: 'string',
                    description: 'Comma-separated subset: index,manifest,refs,context (default: all four)',
                    required: false,
                },
            },
            returns: '{ status, violations[{ rule, path, hint }], summary }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const checksStr = typeof args['checks'] === 'string'
                    ? args['checks']
                    : 'index,manifest,refs,context';
                const activeChecks = new Set(
                    checksStr.split(',').map(s => s.trim()).filter(Boolean),
                );

                const realBase = sandbox.resolveExisting(agentPath);
                if (!fs.statSync(realBase).isDirectory()) {
                    throw new Error(`Path must be a directory: ${agentPath}`);
                }

                const violations: Violation[] = [];
                let dirCount = 0;
                let fileCount = 0;
                let entryCount = 0;
                let truncated = false;

                // Check the root dir itself.
                dirCount++;
                if (activeChecks.has('index'))    checkIndexMissing(realBase, sandbox.root, violations);
                if (activeChecks.has('manifest')) checkManifest(realBase, sandbox.root, violations);

                for (const { real, isDir, name } of walkTree(realBase)) {
                    if (++entryCount > MAX_ENTRIES) { truncated = true; break; }

                    if (isDir) {
                        dirCount++;
                        if (activeChecks.has('index'))    checkIndexMissing(real, sandbox.root, violations);
                        if (activeChecks.has('manifest')) checkManifest(real, sandbox.root, violations);
                    } else {
                        fileCount++;
                        if (activeChecks.has('refs') && name.endsWith('.md') && name !== 'index.md') {
                            checkBrokenRefs(real, sandbox.root, violations);
                        }
                        if (activeChecks.has('context') && name === 'CONTEXT.md') {
                            checkContextSchema(real, sandbox.root, violations);
                        }
                    }
                }

                return {
                    status: violations.length === 0 ? 'pass' : 'fail',
                    violations,
                    summary: {
                        directories_checked: dirCount,
                        files_checked: fileCount,
                        violations: violations.length,
                        ...(truncated ? { warning: `Scan truncated at ${MAX_ENTRIES} entries` } : {}),
                    },
                };
            },
        };
    }
}
