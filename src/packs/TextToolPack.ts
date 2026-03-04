/**
 * TextToolPack — line-native file editing tools for sandbox agents.
 *
 * Mounts a virtual tool group at /tools/text/ with six tools:
 *
 *   text/read          — read a file with 1-based line numbers; response includes MD5 hash
 *   text/write         — create or overwrite an entire file
 *   text/insert        — insert lines after a line number or unique content anchor
 *   text/replace       — atomic find-and-replace (must match exactly once)
 *   text/delete_lines  — remove a contiguous line range
 *   text/search        — search within a single file for a literal or regex pattern
 *   text/find          — find files/dirs by name or glob pattern within a directory tree
 *   text/grep          — search file contents across a directory tree
 *   text/to_markdown   — convert an HTML file in the sandbox to clean Markdown via Defuddle
 *   text/patch         — apply a unified diff (from fs/diff) to a file in-place
 *   text/section       — read the content block under a markdown heading
 *   text/section_write — replace the content block under a markdown heading
 *
 * Etag / write guards:
 *   text/read returns a "hash" field (MD5 of the full file).
 *   text/write, text/replace, and text/patch accept an optional "if_hash" param.
 *   If the file has been modified since the hash was captured the write is rejected
 *   with { ok: false, reason: "stale", current_hash } so the caller can re-read first.
 *
 * Inline validation:
 *   text/write, text/replace, and text/patch accept an optional "validate: true" flag.
 *   When set, a manifest check is run on the parent directory after the write and any
 *   violations are returned as { violations } in the response (non-blocking).
 *
 * text/find accepts a "pattern" glob (e.g. "*.md") to filter by name, and
 * an optional "type" filter ("f" = files, "d" = directories).
 * text/grep accepts the same "pattern"/"regex"/"case_sensitive" options as
 * text/search, plus an optional "glob" to restrict which files are searched.
 *
 * Coordinate system: 1-based line numbers throughout. Line numbers from text/read
 * feed directly into text/insert, text/delete_lines, and text/replace without
 * any offset arithmetic.
 *
 * All paths are agent-visible absolute paths (e.g. "/home/notes.md").
 * Security enforcement is delegated to the Sandbox instance — no duplicate checks.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPatch } from 'diff';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { extractMarkdown } from './html.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { requireString as requireStringShared, normAgentPath as normAgentPathShared } from './pack-helpers.js';

// ─── Constants ───────────────────────────────────────────────────

const MAX_FILE_BYTES  = 1 * 1024 * 1024;  // 1 MB max file size for text ops
const MAX_READ_LINES  = 500;              // max lines returned per read call
const MAX_WRITE_BYTES = 512 * 1024;       // 512 KB write cap (matches sandbox limit)
const MAX_SEARCH_HITS = 50;              // max matches returned per single-file search
const MAX_GREP_HITS   = 100;             // max matches returned per cross-file grep
const MAX_FIND_HITS   = 200;             // max results returned by find
const MAX_TREE_LINES  = 500;             // max lines in tree output before truncation
const MAX_PATTERN_LEN = 500;             // ReDoS mitigation

// ─── Line helpers ────────────────────────────────────────────────

/** Split file content into lines. Trailing \n is treated as a terminator, not a blank line. */
function toLines(content: string): string[] {
    if (!content) return [];
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** Rejoin lines into file content; always ends with \n for Unix convention. */
function fromLines(lines: string[]): string {
    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** Format a window of lines with 1-based line numbers for agent display. */
function formatLines(lines: string[], startLine: number, totalLines: number): string {
    const pad = String(totalLines).length;
    return lines.map((l, i) => `${String(startLine + i).padStart(pad)}: ${l}`).join('\n');
}

// ─── Argument helpers ────────────────────────────────────────────

const requireString = requireStringShared;

function requireInt(args: Record<string, unknown>, key: string): number {
    const n = Number(args[key]);
    if (!Number.isInteger(n)) throw new Error(`"${key}" must be an integer`);
    return n;
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
    if (args[key] == null) return undefined;
    const n = Number(args[key]);
    if (!Number.isInteger(n)) throw new Error(`"${key}" must be an integer`);
    return n;
}

const normAgentPath = normAgentPathShared;

// ─── FS helpers ──────────────────────────────────────────────────

function readFileLines(realPath: string): string[] {
    const st = fs.statSync(realPath);
    if (st.isDirectory()) throw new Error('Path is a directory');
    if (st.size > MAX_FILE_BYTES) {
        throw new Error(`File too large (${st.size} B, limit ${MAX_FILE_BYTES} B). Use fs:read for raw access.`);
    }
    return toLines(fs.readFileSync(realPath, 'utf-8'));
}

function writeFileLines(realPath: string, lines: string[]): void {
    const content = fromLines(lines);
    const byteLen = Buffer.byteLength(content, 'utf-8');
    if (byteLen > MAX_WRITE_BYTES) throw new Error(`Result too large (${byteLen} B, limit ${MAX_WRITE_BYTES} B)`);
    fs.mkdirSync(path.dirname(realPath), { recursive: true });
    fs.writeFileSync(realPath, content, 'utf-8');
}

// ─── Search helpers ──────────────────────────────────────────────

function isReDoSSuspect(pattern: string): boolean {
    return /([+*]\)?[+*]|\([^)]*[+*][^)]*\)[+*?])/.test(pattern);
}

function buildRegex(pattern: string, useRegex: boolean, caseSensitive: boolean): RegExp {
    if (pattern.length > MAX_PATTERN_LEN) {
        throw new Error(`Pattern too long (limit ${MAX_PATTERN_LEN} chars)`);
    }
    const flags = caseSensitive ? '' : 'i';
    if (useRegex) {
        if (isReDoSSuspect(pattern)) {
            throw new Error('Pattern contains nested quantifiers (ReDoS risk) — simplify it');
        }
        return new RegExp(pattern, flags);
    }
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

// ─── Line-to-char-position helper (for replace reporting) ────────

function findLineNumber(content: string, charPos: number): number {
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= charPos) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

// ─── Etag helpers ────────────────────────────────────────────────

/** MD5 of the raw file bytes — used as a lightweight etag. */
function fileHash(realPath: string): string {
    return crypto.createHash('md5').update(fs.readFileSync(realPath)).digest('hex');
}

/**
 * If the caller supplied an `if_hash` guard, verify it matches the current file.
 * Returns a stale-write error object when mismatched so the caller can bail out
 * before doing any work.
 */
function checkHash(
    args: Record<string, unknown>,
    realPath: string,
    agentPath: string,
): { ok: false; reason: 'stale'; current_hash: string } | null {
    const expected = typeof args['if_hash'] === 'string' ? args['if_hash'] : null;
    if (!expected) return null;
    const actual = fileHash(realPath);
    if (actual !== expected) {
        return { ok: false, reason: 'stale', current_hash: actual };
    }
    return null;
}

// ─── Manifest-check helper (for validate flag) ───────────────────

interface ManifestIssue { rule: string; path: string; hint: string }

/**
 * Run a quick INDEX_MISSING / MANIFEST_UNDOC check on the parent directory of a
 * written file.  Used by the "validate" option on write tools — non-blocking, the
 * write has already succeeded when this is called.
 */
function checkParentManifest(fileReal: string, sandboxRoot: string): ManifestIssue[] {
    const dir = path.dirname(fileReal);
    if (!dir.startsWith(sandboxRoot)) return [];

    const agentDir = dir.slice(sandboxRoot.length) || '/';
    const indexReal = path.join(dir, 'index.md');

    if (!fs.existsSync(indexReal)) {
        return [{ rule: 'INDEX_MISSING', path: agentDir, hint: `Create index.md in ${agentDir}` }];
    }

    const name = path.basename(fileReal);
    if (name === 'index.md') return [];

    let content: string;
    try { content = fs.readFileSync(indexReal, 'utf-8'); } catch { return []; }

    if (!content.includes(name)) {
        const agentIndex = `${agentDir === '/' ? '' : agentDir}/index.md`;
        return [{
            rule: 'MANIFEST_UNDOC',
            path: `${agentDir === '/' ? '' : agentDir}/${name}`,
            hint: `"${name}" is not mentioned in ${agentIndex}. Add an entry.`,
        }];
    }
    return [];
}

// ─── Section helpers ─────────────────────────────────────────────

/** Return heading depth (number of leading `#`), or 0 if not a heading line. */
function headingDepth(line: string): number {
    const m = line.match(/^(#+)\s/);
    return m ? m[1]!.length : 0;
}

/**
 * Find the 0-based index of the first line that matches `heading`.
 * Matching rules (in priority order):
 *   1. Exact trimmed match: `"## Scene 1"` matches `"## Scene 1"`.
 *   2. Heading containing bare text: `"Scene 1"` matches any `## Scene 1` heading.
 */
function findHeadingIndex(lines: string[], heading: string): number {
    const needle = heading.trim();
    for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trimEnd() === needle) return i;
    }
    const bare = needle.replace(/^#+\s*/, '').trim();
    if (!bare) return -1;
    for (let i = 0; i < lines.length; i++) {
        const d = headingDepth(lines[i]!);
        if (d > 0 && lines[i]!.replace(/^#+\s*/, '').trimEnd().includes(bare)) return i;
    }
    return -1;
}

/**
 * Return the exclusive end index of the section starting at `startIdx`.
 * The section ends just before the next heading at equal or higher level.
 */
function sectionEndIndex(lines: string[], startIdx: number): number {
    const depth = headingDepth(lines[startIdx]!);
    for (let i = startIdx + 1; i < lines.length; i++) {
        const d = headingDepth(lines[i]!);
        if (d > 0 && d <= depth) return i;
    }
    return lines.length;
}

// ─── Find/grep helpers ───────────────────────────────────────────

/** Convert a simple glob (only * and ?) to a RegExp matching the full string. */
function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

/**
 * Walk a directory tree, yielding every entry (file or dir).
 * Skips hidden entries (dot-prefixed names) and stays within sandboxRoot.
 */
/**
 * Render a directory tree into `lines`. Returns false when MAX_TREE_LINES is
 * hit (caller should append a truncation marker).
 */
function buildTree(
    dirReal: string,
    sandboxRoot: string,
    prefix: string,
    maxDepth: number,
    depth: number,
    lines: string[],
): boolean {
    if (depth >= maxDepth) return true;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dirReal, { withFileTypes: true }); }
    catch { return true; }
    // Dirs first, then files; alphabetical within each group.
    const visible = entries
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    for (let i = 0; i < visible.length; i++) {
        if (lines.length >= MAX_TREE_LINES) return false;
        const e = visible[i]!;
        const isLast = i === visible.length - 1;
        const branch  = isLast ? '└── ' : '├── ';
        const childPfx = prefix + (isLast ? '    ' : '│   ');
        if (e.isDirectory()) {
            let note = '';
            try {
                const idx = fs.statSync(path.join(dirReal, e.name, 'index.md'));
                if (!idx.isDirectory()) note = '  [index.md]';
            } catch { /* no index.md */ }
            lines.push(`${prefix}${branch}${e.name}/${note}`);
            const childReal = path.join(dirReal, e.name);
            if (!childReal.startsWith(sandboxRoot)) continue; // safety
            if (!buildTree(childReal, sandboxRoot, childPfx, maxDepth, depth + 1, lines)) return false;
        } else {
            lines.push(`${prefix}${branch}${e.name}`);
        }
    }
    return true;
}

function* walkEntries(
    dirReal: string,
    sandboxRoot: string,
): Generator<{ abs: string; name: string; isDir: boolean }> {
    const stack = [dirReal];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const abs = path.join(current, e.name);
            if (!abs.startsWith(sandboxRoot + path.sep)) continue;
            yield { abs, name: e.name, isDir: e.isDirectory() };
            if (e.isDirectory()) stack.push(abs);
        }
    }
}

// ─── Pack ────────────────────────────────────────────────────────

export class TextToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('text', [
            this.readTool(),
            this.writeTool(),
            this.insertTool(),
            this.replaceTool(),
            this.deleteLinesTool(),
            this.searchTool(),
            this.findTool(),
            this.grepTool(),
            this.toMarkdownTool(),
            this.treeTool(),
            this.patchTool(),
            this.sectionTool(),
            this.sectionWriteTool(),
        ]).createLayer();
    }

    // ── text/read ───────────────────────────────────────────────

    private readTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'read',
            description: [
                `Read a text file with 1-based line numbers (format: "  N: content").`,
                `Returns up to ${MAX_READ_LINES} lines per call; paginate with from_line/to_line.`,
                'Line numbers from this output feed directly into insert, replace, and delete_lines.',
                'The "hash" field is an MD5 of the full file; pass it as "if_hash" to write tools to guard against concurrent edits.',
            ].join(' '),
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox path (e.g. /home/notes.md)', required: true },
                from_line: { type: 'number', description: '1-based first line to return (default: 1)', required: false },
                to_line: { type: 'number', description: `1-based last line to return (default: from_line + ${MAX_READ_LINES - 1})`, required: false },
            },
            returns: '{ content, from_line, to_line, total_lines, hash }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const real = sandbox.resolveExisting(agentPath);
                const lines = readFileLines(real);
                const total = lines.length;

                const from = Math.max(1, optInt(args, 'from_line') ?? 1);
                if (from > Math.max(1, total)) {
                    throw new Error(`from_line ${from} exceeds total_lines ${total}`);
                }
                const ceiling = Math.min(total, from + MAX_READ_LINES - 1);
                const to = Math.min(ceiling, optInt(args, 'to_line') ?? ceiling);

                return {
                    content: formatLines(lines.slice(from - 1, to), from, total),
                    from_line: from,
                    to_line: to,
                    total_lines: total,
                    hash: fileHash(real),
                };
            },
        };
    }

    // ── text/write ──────────────────────────────────────────────

    private writeTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'write',
            description: 'Create or overwrite a file with the given content. For surgical edits to existing files prefer insert, replace, or delete_lines.',
            parameters: {
                path:     { type: 'string',  description: 'Absolute sandbox path', required: true },
                content:  { type: 'string',  description: 'Full UTF-8 file content', required: true },
                if_hash:  { type: 'string',  description: 'Reject write if file hash differs from this value (from a prior text/read). Prevents clobbering concurrent edits.', required: false },
                validate: { type: 'boolean', description: 'Run a manifest check on the parent directory after writing and return any violations (non-blocking).', required: false },
            },
            returns: '{ ok, total_lines, hash, violations? } or { ok: false, reason: "stale", current_hash }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                sandbox.assertWritable(agentPath, callerHandle);
                const real = sandbox.resolveForWrite(agentPath);

                if (fs.existsSync(real)) {
                    const stale = checkHash(args, real, agentPath);
                    if (stale) return stale;
                }

                const content = typeof args['content'] === 'string' ? args['content'] : '';
                const byteLen = Buffer.byteLength(content, 'utf-8');
                if (byteLen > MAX_WRITE_BYTES) {
                    throw new Error(`Content too large (${byteLen} B, limit ${MAX_WRITE_BYTES} B)`);
                }
                fs.mkdirSync(path.dirname(real), { recursive: true });
                fs.writeFileSync(real, content, 'utf-8');

                const result: Record<string, unknown> = {
                    ok: true,
                    total_lines: toLines(content).length,
                    hash: fileHash(real),
                };
                if (args['validate'] === true) {
                    result['violations'] = checkParentManifest(real, sandbox.root);
                }
                return result;
            },
        };
    }

    // ── text/insert ─────────────────────────────────────────────

    private insertTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'insert',
            description: [
                'Insert text into a file after a specific line.',
                'Prefer after_match (content anchor) — stays stable when surrounding lines shift.',
                'after_match: insert after the unique line containing this exact string.',
                'AMBIGUOUS error if more than one line matches — add more context.',
                'after_line: insert after the given 1-based line number; 0 = prepend.',
                'Provide exactly one of after_match or after_line.',
            ].join(' '),
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox path', required: true },
                content: { type: 'string', description: 'Text to insert (may contain newlines)', required: true },
                after_match: { type: 'string', description: 'Insert after the unique line containing this exact string. AMBIGUOUS if >1 line matches.', required: false },
                after_line: { type: 'number', description: '1-based line number to insert after; 0 = prepend.', required: false },
            },
            returns: '{ ok, inserted_lines, total_lines }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                sandbox.assertWritable(agentPath, callerHandle);
                const real = sandbox.resolveExisting(agentPath);
                const content = requireString(args, 'content');
                const lines = readFileLines(real);

                const hasMatch = args['after_match'] != null;
                const hasLine  = args['after_line'] != null;
                if (hasMatch && hasLine) throw new Error('Provide either after_match or after_line, not both');
                if (!hasMatch && !hasLine) throw new Error('One of after_match or after_line is required');

                let afterIndex: number; // 0-based splice position (insert before this index)
                if (hasMatch) {
                    const anchor = requireString(args, 'after_match');
                    const hits = lines.reduce<number[]>((acc, l, i) => {
                        if (l.includes(anchor)) acc.push(i);
                        return acc;
                    }, []);
                    if (hits.length === 0) throw new Error(`after_match: no line contains "${anchor}"`);
                    if (hits.length > 1) {
                        throw new Error(
                            `after_match: "${anchor}" matches ${hits.length} lines ` +
                            `(${hits.map(i => i + 1).join(', ')}). Add more context to make it unique.`,
                        );
                    }
                    afterIndex = hits[0]! + 1;
                } else {
                    const n = optInt(args, 'after_line') ?? 0;
                    if (n < 0 || n > lines.length) {
                        throw new Error(`after_line ${n} out of range (0–${lines.length})`);
                    }
                    afterIndex = n;
                }

                // Parse new content into lines; ensure trailing \n before splitting
                const newLines = toLines(content.endsWith('\n') ? content : content + '\n');
                const updated = [...lines.slice(0, afterIndex), ...newLines, ...lines.slice(afterIndex)];
                writeFileLines(real, updated);
                return { ok: true, inserted_lines: newLines.length, total_lines: updated.length };
            },
        };
    }

    // ── text/replace ────────────────────────────────────────────

    private replaceTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'replace',
            description: [
                'Atomically replace one exact occurrence of "old" text with "new" text.',
                '"old" must appear exactly once — AMBIGUOUS error if more than one match.',
                'NOT_FOUND error includes nearest line hints to help self-correct.',
                'Preferred surgical edit operation — prefer this over full rewrites.',
            ].join(' '),
            parameters: {
                path:     { type: 'string',  description: 'Absolute sandbox path', required: true },
                old:      { type: 'string',  description: 'Exact text to replace (must appear exactly once)', required: true },
                new:      { type: 'string',  description: 'Replacement text (use "" to delete the match)', required: true },
                if_hash:  { type: 'string',  description: 'Reject write if file hash differs from this value (from a prior text/read).', required: false },
                validate: { type: 'boolean', description: 'Run a manifest check on the parent directory after writing and return any violations.', required: false },
            },
            returns: '{ ok, changed_line, total_lines, hash, violations? } or { ok: false, reason: "stale", current_hash }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                sandbox.assertWritable(agentPath, callerHandle);
                const real = sandbox.resolveExisting(agentPath);

                const stale = checkHash(args, real, agentPath);
                if (stale) return stale;
                const st = fs.statSync(real);
                if (st.isDirectory()) throw new Error('Path is a directory');
                if (st.size > MAX_FILE_BYTES) throw new Error('File too large');

                const oldText = requireString(args, 'old');
                const newText = typeof args['new'] === 'string' ? args['new'] : '';
                if (!oldText) throw new Error('"old" must not be empty');

                const content = fs.readFileSync(real, 'utf-8');

                // Find all occurrences (cap at 11 to detect >10 without full scan)
                const positions: number[] = [];
                let pos = 0;
                while ((pos = content.indexOf(oldText, pos)) !== -1) {
                    positions.push(pos);
                    pos += oldText.length;
                    if (positions.length > 10) break;
                }

                if (positions.length === 0) {
                    // Score file lines by shared words from the first line of oldText
                    const firstLine = oldText.trim().split('\n')[0] ?? '';
                    const words = firstLine.split(/\s+/).filter(w => w.length >= 3);
                    const hints = toLines(content)
                        .map((l, i) => ({
                            line: i + 1,
                            text: l,
                            score: words.reduce((s, w) => s + (l.includes(w) ? w.length : 0), 0),
                        }))
                        .filter(x => x.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 3)
                        .map(x => `L${x.line}: ${x.text.trim().slice(0, 60)}`);
                    const hint = hints.length > 0
                        ? `\nNearest lines: ${hints.join(' | ')}`
                        : ' Use text/read to inspect the file.';
                    throw new Error(`"old" text not found in ${agentPath}.${hint}`);
                }

                if (positions.length > 1) {
                    const lineNums = [...new Set(positions.map(p => findLineNumber(content, p)))];
                    throw new Error(
                        `"old" appears ${positions.length} times at lines ${lineNums.join(', ')}. ` +
                        `Include more surrounding lines in "old" to make it unique.`,
                    );
                }

                const idx = positions[0]!;
                const patched = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
                if (Buffer.byteLength(patched, 'utf-8') > MAX_WRITE_BYTES) throw new Error('Result too large');
                fs.writeFileSync(real, patched, 'utf-8');

                const result: Record<string, unknown> = {
                    ok: true,
                    changed_line: findLineNumber(content, idx),
                    total_lines: toLines(patched).length,
                    hash: fileHash(real),
                };
                if (args['validate'] === true) {
                    result['violations'] = checkParentManifest(real, sandbox.root);
                }
                return result;
            },
        };
    }

    // ── text/delete_lines ───────────────────────────────────────

    private deleteLinesTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'delete_lines',
            description: 'Delete a range of lines from a file. Both from_line and to_line are 1-based and inclusive. Use text/read first to confirm the range.',
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox path', required: true },
                from_line: { type: 'number', description: '1-based first line to delete', required: true },
                to_line: { type: 'number', description: '1-based last line to delete (inclusive)', required: true },
            },
            returns: '{ ok, deleted_lines, total_lines }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                sandbox.assertWritable(agentPath, callerHandle);
                const real = sandbox.resolveExisting(agentPath);
                const lines = readFileLines(real);
                const from = requireInt(args, 'from_line');
                const to   = requireInt(args, 'to_line');
                if (from < 1 || from > lines.length) throw new Error(`from_line ${from} out of range (1–${lines.length})`);
                if (to < from || to > lines.length) throw new Error(`to_line ${to} out of range (${from}–${lines.length})`);
                const deleted = to - from + 1;
                const updated = [...lines.slice(0, from - 1), ...lines.slice(to)];
                writeFileLines(real, updated);
                return { ok: true, deleted_lines: deleted, total_lines: updated.length };
            },
        };
    }

    // ── text/find ───────────────────────────────────────────────

    private findTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'find',
            description: [
                `Find files and directories by name or glob pattern (e.g. "*.md", "notes.txt").`,
                `Returns up to ${MAX_FIND_HITS} results as { path, type } objects.`,
                '"type" field is "f" (file) or "d" (directory).',
            ].join(' '),
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox directory to search (e.g. /home)', required: true },
                pattern: { type: 'string', description: 'Name or glob pattern to match (e.g. "*.md"). Omit to return all entries.', required: false },
                type: { type: 'string', description: '"f" for files only, "d" for directories only. Omit for both.', required: false },
            },
            returns: '{ results: { path, type }[], truncated }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const real = sandbox.resolveExisting(agentPath);
                const st = fs.statSync(real);
                if (!st.isDirectory()) throw new Error(`Path is not a directory: ${agentPath}`);

                const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : null;
                const typeFilter = typeof args['type'] === 'string' ? args['type'] : null;
                if (typeFilter && typeFilter !== 'f' && typeFilter !== 'd') {
                    throw new Error('"type" must be "f" (files), "d" (directories), or omitted');
                }
                const nameRe = pattern ? globToRegex(pattern) : null;

                const results: Array<{ path: string; type: 'f' | 'd' }> = [];
                let truncated = false;
                for (const entry of walkEntries(real, sandbox.root)) {
                    if (typeFilter === 'f' && entry.isDir) continue;
                    if (typeFilter === 'd' && !entry.isDir) continue;
                    if (nameRe && !nameRe.test(entry.name)) continue;
                    if (results.length >= MAX_FIND_HITS) { truncated = true; break; }
                    results.push({ path: entry.abs.slice(sandbox.root.length) || '/', type: entry.isDir ? 'd' : 'f' });
                }
                return { results, truncated };
            },
        };
    }

    // ── text/grep ───────────────────────────────────────────────

    private grepTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'grep',
            description: [
                `Search file contents across a directory tree.`,
                `Returns up to ${MAX_GREP_HITS} matches as { file, line, text } objects.`,
                'Use "glob" to restrict which files are searched (e.g. "*.md").',
            ].join(' '),
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox directory to search', required: true },
                pattern: { type: 'string', description: 'Search pattern (literal string by default)', required: true },
                regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default: false)', required: false },
                case_sensitive: { type: 'boolean', description: 'Case-sensitive match (default: true)', required: false },
                glob: { type: 'string', description: 'Only search files whose names match this glob (e.g. "*.md")', required: false },
            },
            returns: '{ matches: { file, line, text }[], truncated }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const real = sandbox.resolveExisting(agentPath);
                const st = fs.statSync(real);
                if (!st.isDirectory()) throw new Error(`Path is not a directory: ${agentPath}`);

                const pattern = requireString(args, 'pattern');
                const isRegex = args['regex'] === true;
                const caseSensitive = args['case_sensitive'] !== false;
                const globFilter = typeof args['glob'] === 'string' ? args['glob'] : null;
                const fileRe = globFilter ? globToRegex(globFilter) : null;
                const re = buildRegex(pattern, isRegex, caseSensitive);

                const matches: Array<{ file: string; line: number; text: string }> = [];
                let truncated = false;
                outer: for (const entry of walkEntries(real, sandbox.root)) {
                    if (entry.isDir) continue;
                    if (fileRe && !fileRe.test(entry.name)) continue;
                    const fileSt = fs.statSync(entry.abs);
                    if (fileSt.size > MAX_FILE_BYTES) continue; // skip huge files silently
                    let lines: string[];
                    try { lines = toLines(fs.readFileSync(entry.abs, 'utf-8')); }
                    catch { continue; }
                    const filePath = entry.abs.slice(sandbox.root.length) || '/';
                    for (let i = 0; i < lines.length; i++) {
                        re.lastIndex = 0;
                        if (re.test(lines[i]!)) {
                            matches.push({ file: filePath, line: i + 1, text: lines[i]! });
                            if (matches.length >= MAX_GREP_HITS) { truncated = true; break outer; }
                        }
                    }
                }
                return { matches, truncated };
            },
        };
    }

    // ── text/to_markdown ─────────────────────────────────────────

    private toMarkdownTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'to_markdown',
            description: [
                'Convert an HTML file in the sandbox to clean Markdown using Defuddle.',
                'Strips boilerplate (nav, ads, footers) and returns readable article content.',
                'Overwrites the source file unless "dest" is specified.',
            ].join(' '),
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox path to the HTML file', required: true },
                url:  { type: 'string', description: 'Original URL of the page (improves link resolution in output)', required: false },
                dest: { type: 'string', description: 'Output path. Defaults to overwriting the source file.', required: false },
            },
            returns: '{ path, bytes }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const real = sandbox.resolveExisting(agentPath);
                const st = fs.statSync(real);
                if (st.isDirectory()) throw new Error(`Path is a directory: ${agentPath}`);
                if (st.size > MAX_FILE_BYTES) throw new Error(`File too large: ${agentPath}`);

                // Validate destination before doing the expensive Defuddle work.
                const destPath = typeof args['dest'] === 'string'
                    ? normAgentPath(args['dest'])
                    : agentPath;
                sandbox.assertWritable(destPath, callerHandle);
                const realDest = sandbox.resolveForWrite(destPath);

                const html = fs.readFileSync(real, 'utf-8');
                const url = typeof args['url'] === 'string' ? args['url'] : '';
                const md = await extractMarkdown(html, url);
                if (md === null) throw new Error(`Defuddle could not extract readable content from ${agentPath}`);
                fs.mkdirSync(path.dirname(realDest), { recursive: true });
                fs.writeFileSync(realDest, md, 'utf-8');

                return { path: destPath, bytes: Buffer.byteLength(md, 'utf-8') };
            },
        };
    }

    // ── text/tree ────────────────────────────────────────────────

    private treeTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'tree',
            description: [
                'Render a directory as a tree. Directories containing index.md are annotated [index.md].',
                `Capped at ${MAX_TREE_LINES} lines. Skips hidden (dot-prefixed) entries.`,
            ].join(' '),
            parameters: {
                path:  { type: 'string', description: 'Absolute sandbox directory to render', required: true },
                depth: { type: 'number', description: 'Maximum depth to expand (1–10, default: 10)', required: false },
            },
            returns: '{ output: string }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const rawDepth = optInt(args, 'depth');
                const maxDepth = rawDepth ?? 10;
                if (maxDepth < 1 || maxDepth > 10) throw new Error('"depth" must be between 1 and 10');
                const real = sandbox.resolveExisting(agentPath);
                if (!fs.statSync(real).isDirectory()) throw new Error(`Path is not a directory: ${agentPath}`);
                const lines: string[] = [agentPath];
                const complete = buildTree(real, sandbox.root, '', maxDepth, 0, lines);
                if (!complete) lines.push('... (truncated)');
                return { output: lines.join('\n') };
            },
        };
    }

    // ── text/patch ──────────────────────────────────────────────

    private patchTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'patch',
            description: [
                'Apply a unified diff (produced by fs/diff) to a file in-place.',
                'The patch must target the same file specified in "path".',
                'Fails with a clear error if the patch does not apply cleanly.',
            ].join(' '),
            parameters: {
                path:     { type: 'string',  description: 'Absolute sandbox path of the file to patch', required: true },
                patch:    { type: 'string',  description: 'Unified diff string (from fs/diff)', required: true },
                if_hash:  { type: 'string',  description: 'Reject write if file hash differs from this value (from a prior text/read).', required: false },
                validate: { type: 'boolean', description: 'Run a manifest check on the parent directory after patching and return any violations.', required: false },
            },
            returns: '{ path, lines_before, lines_after, hash, violations? } or { ok: false, reason: "stale", current_hash }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const patchStr  = requireString(args, 'patch');

                sandbox.assertWritable(agentPath, callerHandle);
                const real = sandbox.resolveExisting(agentPath);

                const stale = checkHash(args, real, agentPath);
                if (stale) return stale;

                const lines = readFileLines(real);
                const original = fromLines(lines);

                const patched = applyPatch(original, patchStr);
                if (patched === false) {
                    throw new Error(
                        `Patch did not apply cleanly to ${agentPath}. ` +
                        'Ensure the diff was produced from the current file contents.'
                    );
                }

                const byteLen = Buffer.byteLength(patched, 'utf-8');
                if (byteLen > MAX_WRITE_BYTES) {
                    throw new Error(`Result too large (${byteLen} B, limit ${MAX_WRITE_BYTES} B)`);
                }
                fs.writeFileSync(real, patched, 'utf-8');

                const linesAfter = toLines(patched);
                const result: Record<string, unknown> = {
                    path: agentPath,
                    lines_before: lines.length,
                    lines_after: linesAfter.length,
                    hash: fileHash(real),
                };
                if (args['validate'] === true) {
                    result['violations'] = checkParentManifest(real, sandbox.root);
                }
                return result;
            },
        };
    }

    // ── text/section ────────────────────────────────────────────

    private sectionTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'section',
            description: [
                'Read the content block under a specific markdown heading without loading the whole file.',
                'Returns the body (lines after the heading up to the next equal-or-higher heading),',
                'plus the heading line, line range, total file lines, and the full-file hash.',
                'Use the hash with text/section_write "if_hash" to guard against concurrent edits.',
            ].join(' '),
            parameters: {
                path:    { type: 'string', description: 'Absolute sandbox path to the markdown file', required: true },
                heading: { type: 'string', description: 'Heading to find, e.g. "## Scene 1" or just "Scene 1"', required: true },
            },
            returns: '{ heading_line, heading_text, from_line, to_line, total_lines, hash, content }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const heading   = requireString(args, 'heading');

                const real  = sandbox.resolveExisting(agentPath);
                const lines = readFileLines(real);

                const startIdx = findHeadingIndex(lines, heading);
                if (startIdx < 0) {
                    throw new Error(`Heading not found in ${agentPath}: "${heading}"`);
                }
                const endIdx = sectionEndIndex(lines, startIdx);

                // Body is everything after the heading line, up to (not including) endIdx.
                const bodyLines = lines.slice(startIdx + 1, endIdx);

                return {
                    heading_line: startIdx + 1,                    // 1-based
                    heading_text: lines[startIdx]!,
                    from_line:    startIdx + 2,                    // first body line (1-based)
                    to_line:      endIdx,                          // last body line (1-based, inclusive)
                    total_lines:  lines.length,
                    hash:         fileHash(real),
                    content:      bodyLines.join('\n') + (bodyLines.length > 0 ? '\n' : ''),
                };
            },
        };
    }

    // ── text/section_write ──────────────────────────────────────

    private sectionWriteTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'section_write',
            description: [
                'Replace the body of a markdown section (everything after the heading line up to the',
                'next equal-or-higher heading) without touching the rest of the file.',
                'The heading line itself is preserved unchanged.',
                'Pass the hash from text/section or text/read as "if_hash" to guard against concurrent edits.',
                'Use "validate: true" to get a manifest check on the parent directory after writing.',
            ].join(' '),
            parameters: {
                path:     { type: 'string',  description: 'Absolute sandbox path to the markdown file', required: true },
                heading:  { type: 'string',  description: 'Heading to target, e.g. "## Scene 1" or just "Scene 1"', required: true },
                content:  { type: 'string',  description: 'New body content to place after the heading (the heading line itself is not replaced)', required: true },
                if_hash:  { type: 'string',  description: 'Reject write if file hash differs from this value.', required: false },
                validate: { type: 'boolean', description: 'Run a manifest check on the parent directory after writing and return any violations.', required: false },
            },
            returns: '{ ok, heading_text, from_line, to_line, total_lines, hash, violations? } or { ok: false, reason: "stale", current_hash }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const heading   = requireString(args, 'heading');
                const newBody   = requireString(args, 'content');

                sandbox.assertWritable(agentPath, callerHandle);
                const real  = sandbox.resolveExisting(agentPath);

                const stale = checkHash(args, real, agentPath);
                if (stale) return stale;

                const lines    = readFileLines(real);
                const startIdx = findHeadingIndex(lines, heading);
                if (startIdx < 0) {
                    throw new Error(`Heading not found in ${agentPath}: "${heading}"`);
                }
                const endIdx = sectionEndIndex(lines, startIdx);

                // Normalise the new body: ensure it ends with a newline before splitting.
                const bodyLines = toLines(newBody.endsWith('\n') ? newBody : newBody + '\n');

                const updated = [
                    ...lines.slice(0, startIdx + 1),  // everything up to and including the heading
                    ...bodyLines,
                    ...lines.slice(endIdx),            // everything from the next heading onwards
                ];

                writeFileLines(real, updated);

                const result: Record<string, unknown> = {
                    ok:           true,
                    heading_text: lines[startIdx]!,
                    from_line:    startIdx + 2,
                    to_line:      startIdx + 1 + bodyLines.length,
                    total_lines:  updated.length,
                    hash:         fileHash(real),
                };
                if (args['validate'] === true) {
                    result['violations'] = checkParentManifest(real, sandbox.root);
                }
                return result;
            },
        };
    }

    // ── text/search ─────────────────────────────────────────────

    private searchTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'search',
            description: `Search a file for a pattern. Returns up to ${MAX_SEARCH_HITS} matches with 1-based line numbers and full line text.`,
            parameters: {
                path: { type: 'string', description: 'Absolute sandbox path', required: true },
                pattern: { type: 'string', description: 'Search pattern (literal string by default)', required: true },
                regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default: false)', required: false },
                case_sensitive: { type: 'boolean', description: 'Case-sensitive match (default: true)', required: false },
            },
            returns: '{ matches: { line, text }[], truncated }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const real = sandbox.resolveExisting(agentPath);
                const lines = readFileLines(real);
                const pattern = requireString(args, 'pattern');
                const isRegex = args['regex'] === true;
                const caseSensitive = args['case_sensitive'] !== false;

                const re = buildRegex(pattern, isRegex, caseSensitive);
                const matches: Array<{ line: number; text: string }> = [];
                for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_HITS; i++) {
                    re.lastIndex = 0;
                    if (re.test(lines[i]!)) matches.push({ line: i + 1, text: lines[i]! });
                }
                return { matches, truncated: matches.length >= MAX_SEARCH_HITS };
            },
        };
    }
}
