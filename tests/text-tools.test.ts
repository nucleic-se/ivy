/**
 * Tests for TextToolPack — line-native file editing tools.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { TextToolPack } from '../src/packs/TextToolPack.js';
import { FsToolPack } from '../src/packs/FsToolPack.js';

// ─── Helpers ────────────────────────────────────────────────────

class TestableSandbox extends Sandbox {
    constructor(explicitRoot: string) {
        super();
        (this as any).root = explicitRoot;
        for (const dir of ['home', 'tools', 'data', 'tmp']) {
            fs.mkdirSync(path.join(explicitRoot, dir), { recursive: true });
        }
    }
}

function tempSandbox() {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-text-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new TextToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

/** Call a text tool and return its parsed JSON result. */
async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>) {
    const raw = await sandbox.execCall(`text/${tool}`, args, '@test');
    // format: "call:text/<tool> → <json>"  (' → ' = 3 chars)
    const arrow = raw.indexOf(' \u2192 ');
    return JSON.parse(raw.slice(arrow + 3));
}

/** Write a file in the sandbox home directory. */
function write(root: string, name: string, content: string) {
    fs.writeFileSync(path.join(root, 'home', name), content, 'utf-8');
}

/** Read a file from the sandbox home directory. */
function read(root: string, name: string) {
    return fs.readFileSync(path.join(root, 'home', name), 'utf-8');
}

// ─── text/read ───────────────────────────────────────────────────

describe('text/read', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('reads a file with 1-based line numbers', async () => {
        write(root, 'hello.md', 'line one\nline two\nline three\n');
        const r = await call(sandbox, 'read', { path: '/home/hello.md' });
        expect(r.total_lines).toBe(3);
        expect(r.from_line).toBe(1);
        expect(r.to_line).toBe(3);
        expect(r.content).toContain('1: line one');
        expect(r.content).toContain('2: line two');
        expect(r.content).toContain('3: line three');
    });

    it('paginates with from_line and to_line', async () => {
        write(root, 'pages.md', 'a\nb\nc\nd\ne\n');
        const r = await call(sandbox, 'read', { path: '/home/pages.md', from_line: 2, to_line: 4 });
        expect(r.from_line).toBe(2);
        expect(r.to_line).toBe(4);
        expect(r.total_lines).toBe(5);
        expect(r.content).not.toContain('1: a');
        expect(r.content).toContain('2: b');
        expect(r.content).toContain('4: d');
        expect(r.content).not.toContain('5: e');
    });

    it('handles a file without trailing newline', async () => {
        write(root, 'notail.md', 'only line');
        const r = await call(sandbox, 'read', { path: '/home/notail.md' });
        expect(r.total_lines).toBe(1);
        expect(r.content).toContain('1: only line');
    });

    it('pads line numbers to consistent width', async () => {
        write(root, 'tenlines.md', Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
        const r = await call(sandbox, 'read', { path: '/home/tenlines.md' });
        // line 1 should be padded to match " 10:"
        expect(r.content).toMatch(/^ 1: L1/m);
        expect(r.content).toMatch(/^10: L10/m);
    });

    it('throws for a non-existent file', async () => {
        await expect(call(sandbox, 'read', { path: '/home/missing.md' })).rejects.toThrow(/No such file/);
    });

    it('throws for a directory', async () => {
        await expect(call(sandbox, 'read', { path: '/home' })).rejects.toThrow(/directory/);
    });

    it('rejects relative paths', async () => {
        await expect(call(sandbox, 'read', { path: 'home/file.md' })).rejects.toThrow(/absolute/);
    });
});

// ─── text/write ──────────────────────────────────────────────────

describe('text/write', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('creates a new file', async () => {
        const r = await call(sandbox, 'write', { path: '/home/new.md', content: 'hello\nworld\n' });
        expect(r.ok).toBe(true);
        expect(r.total_lines).toBe(2);
        expect(read(root, 'new.md')).toBe('hello\nworld\n');
    });

    it('overwrites an existing file', async () => {
        write(root, 'existing.md', 'old content\n');
        await call(sandbox, 'write', { path: '/home/existing.md', content: 'new content\n' });
        expect(read(root, 'existing.md')).toBe('new content\n');
    });

    it('allows writes to /data (shared writable space)', async () => {
        const r = await call(sandbox, 'write', { path: '/data/shared.md', content: 'shared content\n' });
        expect(r.ok).toBe(true);
    });

    it('rejects writes to /tools (read-only zone)', async () => {
        await expect(call(sandbox, 'write', { path: '/tools/bad.md', content: 'x' })).rejects.toThrow(/read-only/);
    });
});

// ─── text/insert ─────────────────────────────────────────────────

describe('text/insert', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('inserts after a specific line number', async () => {
        write(root, 'f.md', 'a\nb\nc\n');
        const r = await call(sandbox, 'insert', { path: '/home/f.md', content: 'X\n', after_line: 2 });
        expect(r.ok).toBe(true);
        expect(r.inserted_lines).toBe(1);
        expect(r.total_lines).toBe(4);
        expect(read(root, 'f.md')).toBe('a\nb\nX\nc\n');
    });

    it('prepends with after_line: 0', async () => {
        write(root, 'f.md', 'a\nb\n');
        await call(sandbox, 'insert', { path: '/home/f.md', content: 'TOP\n', after_line: 0 });
        expect(read(root, 'f.md')).toBe('TOP\na\nb\n');
    });

    it('appends with after_line equal to total_lines', async () => {
        write(root, 'f.md', 'a\nb\n');
        await call(sandbox, 'insert', { path: '/home/f.md', content: 'END\n', after_line: 2 });
        expect(read(root, 'f.md')).toBe('a\nb\nEND\n');
    });

    it('inserts after a unique matching line with after_match', async () => {
        write(root, 'f.md', 'section one\ncontent here\nsection two\n');
        await call(sandbox, 'insert', { path: '/home/f.md', content: 'injected\n', after_match: 'section one' });
        expect(read(root, 'f.md')).toBe('section one\ninjected\ncontent here\nsection two\n');
    });

    it('inserts multiple lines', async () => {
        write(root, 'f.md', 'a\nb\n');
        await call(sandbox, 'insert', { path: '/home/f.md', content: 'x\ny\nz\n', after_line: 1 });
        expect(read(root, 'f.md')).toBe('a\nx\ny\nz\nb\n');
    });

    it('throws AMBIGUOUS when after_match matches multiple lines', async () => {
        write(root, 'f.md', 'foo bar\nfoo baz\n');
        await expect(
            call(sandbox, 'insert', { path: '/home/f.md', content: 'X\n', after_match: 'foo' }),
        ).rejects.toThrow(/matches 2 lines/);
    });

    it('throws when after_match has no match', async () => {
        write(root, 'f.md', 'hello\n');
        await expect(
            call(sandbox, 'insert', { path: '/home/f.md', content: 'X\n', after_match: 'nothere' }),
        ).rejects.toThrow(/no line contains/);
    });

    it('throws when neither after_line nor after_match provided', async () => {
        write(root, 'f.md', 'hello\n');
        await expect(
            call(sandbox, 'insert', { path: '/home/f.md', content: 'X\n' }),
        ).rejects.toThrow(/One of after_match or after_line/);
    });

    it('throws when both after_line and after_match provided', async () => {
        write(root, 'f.md', 'hello\n');
        await expect(
            call(sandbox, 'insert', { path: '/home/f.md', content: 'X\n', after_line: 1, after_match: 'hello' }),
        ).rejects.toThrow(/not both/);
    });
});

// ─── text/replace ────────────────────────────────────────────────

describe('text/replace', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('replaces an exact occurrence', async () => {
        write(root, 'f.md', 'hello world\n');
        const r = await call(sandbox, 'replace', { path: '/home/f.md', old: 'world', new: 'earth' });
        expect(r.ok).toBe(true);
        expect(r.changed_line).toBe(1);
        expect(read(root, 'f.md')).toBe('hello earth\n');
    });

    it('can replace across multiple lines', async () => {
        write(root, 'f.md', 'start\nmiddle\nend\n');
        const r = await call(sandbox, 'replace', { path: '/home/f.md', old: 'start\nmiddle', new: 'replaced' });
        expect(r.ok).toBe(true);
        expect(read(root, 'f.md')).toBe('replaced\nend\n');
    });

    it('can delete text by replacing with empty string', async () => {
        write(root, 'f.md', 'keep this\ndelete me\nkeep that\n');
        await call(sandbox, 'replace', { path: '/home/f.md', old: 'delete me\n', new: '' });
        expect(read(root, 'f.md')).toBe('keep this\nkeep that\n');
    });

    it('reports changed_line correctly', async () => {
        write(root, 'f.md', 'line1\nline2\ntarget\nline4\n');
        const r = await call(sandbox, 'replace', { path: '/home/f.md', old: 'target', new: 'replaced' });
        expect(r.changed_line).toBe(3);
    });

    it('throws NOT_FOUND with nearest line hints when old not found', async () => {
        write(root, 'f.md', 'hello world\nfoo bar\n');
        await expect(
            call(sandbox, 'replace', { path: '/home/f.md', old: 'hello earth', new: 'x' }),
        ).rejects.toThrow(/not found/);
    });

    it('throws AMBIGUOUS when old appears multiple times', async () => {
        write(root, 'f.md', 'foo\nfoo\nbar\n');
        await expect(
            call(sandbox, 'replace', { path: '/home/f.md', old: 'foo', new: 'baz' }),
        ).rejects.toThrow(/appears 2 times/);
    });

    it('throws when old is empty', async () => {
        write(root, 'f.md', 'hello\n');
        await expect(
            call(sandbox, 'replace', { path: '/home/f.md', old: '', new: 'x' }),
        ).rejects.toThrow(/"old" must not be empty/);
    });
});

// ─── text/delete_lines ───────────────────────────────────────────

describe('text/delete_lines', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('deletes a range of lines', async () => {
        write(root, 'f.md', 'a\nb\nc\nd\ne\n');
        const r = await call(sandbox, 'delete_lines', { path: '/home/f.md', from_line: 2, to_line: 4 });
        expect(r.ok).toBe(true);
        expect(r.deleted_lines).toBe(3);
        expect(r.total_lines).toBe(2);
        expect(read(root, 'f.md')).toBe('a\ne\n');
    });

    it('deletes a single line (from_line === to_line)', async () => {
        write(root, 'f.md', 'a\nb\nc\n');
        await call(sandbox, 'delete_lines', { path: '/home/f.md', from_line: 2, to_line: 2 });
        expect(read(root, 'f.md')).toBe('a\nc\n');
    });

    it('deletes all lines', async () => {
        write(root, 'f.md', 'a\nb\n');
        const r = await call(sandbox, 'delete_lines', { path: '/home/f.md', from_line: 1, to_line: 2 });
        expect(r.total_lines).toBe(0);
        expect(read(root, 'f.md')).toBe('');
    });

    it('throws when from_line is out of range', async () => {
        write(root, 'f.md', 'a\nb\n');
        await expect(
            call(sandbox, 'delete_lines', { path: '/home/f.md', from_line: 5, to_line: 5 }),
        ).rejects.toThrow(/out of range/);
    });

    it('throws when to_line < from_line', async () => {
        write(root, 'f.md', 'a\nb\nc\n');
        await expect(
            call(sandbox, 'delete_lines', { path: '/home/f.md', from_line: 3, to_line: 1 }),
        ).rejects.toThrow(/out of range/);
    });
});

// ─── text/search ─────────────────────────────────────────────────

describe('text/search', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('finds literal pattern matches', async () => {
        write(root, 'f.md', 'foo bar\nbaz qux\nfoo baz\n');
        const r = await call(sandbox, 'search', { path: '/home/f.md', pattern: 'foo' });
        expect(r.matches).toHaveLength(2);
        expect(r.matches[0]).toEqual({ line: 1, text: 'foo bar' });
        expect(r.matches[1]).toEqual({ line: 3, text: 'foo baz' });
        expect(r.truncated).toBe(false);
    });

    it('supports case-insensitive search', async () => {
        write(root, 'f.md', 'Hello World\nhello world\n');
        const r = await call(sandbox, 'search', { path: '/home/f.md', pattern: 'hello', case_sensitive: false });
        expect(r.matches).toHaveLength(2);
    });

    it('supports regex patterns', async () => {
        write(root, 'f.md', 'foo123\nbar456\nbaz789\n');
        const r = await call(sandbox, 'search', { path: '/home/f.md', pattern: '\\d+', regex: true });
        expect(r.matches).toHaveLength(3);
    });

    it('returns empty matches when nothing found', async () => {
        write(root, 'f.md', 'nothing here\n');
        const r = await call(sandbox, 'search', { path: '/home/f.md', pattern: 'missing' });
        expect(r.matches).toHaveLength(0);
        expect(r.truncated).toBe(false);
    });

    it('throws on ReDoS-suspect regex', async () => {
        write(root, 'f.md', 'content\n');
        await expect(
            call(sandbox, 'search', { path: '/home/f.md', pattern: '(a+)+', regex: true }),
        ).rejects.toThrow(/nested quantifiers/);
    });

    it('throws for a non-existent file', async () => {
        await expect(
            call(sandbox, 'search', { path: '/home/missing.md', pattern: 'x' }),
        ).rejects.toThrow(/No such file/);
    });
});

// ─── Tool discovery ──────────────────────────────────────────────

describe('text tool discovery', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('ls /tools shows text group', async () => {
        const r = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools' });
        expect(r).toContain('d  text');
    });

    it('ls /tools/text lists all tool manifests', async () => {
        const r = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/text' });
        for (const name of ['read', 'write', 'insert', 'replace', 'delete_lines', 'search', 'find', 'grep', 'to_markdown', 'tree']) {
            expect(r).toContain(`f  ${name}.json`);
        }
    });

    it('read /tools/text/read.json returns a valid manifest', async () => {
        const r = await sandbox.execFs({ type: 'fs', op: 'read', path: '/tools/text/read.json' });
        const manifest = JSON.parse(r.split('\n').slice(1).join('\n'));
        expect(manifest.name).toBe('read');
        expect(manifest.group).toBe('text');
        expect(manifest.call).toBe('text/read');
        expect(manifest.parameters).toBeDefined();
    });

    it('listTools returns all 10 text tools', () => {
        const tools = sandbox.listTools();
        const textTools = tools.filter(t => t.group === 'text');
        const names = textTools.map(t => t.name);
        for (const n of ['read', 'write', 'insert', 'replace', 'delete_lines', 'search', 'find', 'grep', 'to_markdown', 'tree']) {
            expect(names).toContain(n);
        }
    });
});

// ─── text/find ────────────────────────────────────────────────────

describe('text/find', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns all entries when no pattern given', async () => {
        write(root, 'a.md', 'A');
        write(root, 'b.txt', 'B');
        const r = await call(sandbox, 'find', { path: '/home' });
        const paths = r.results.map((x: any) => x.path);
        expect(paths).toContain('/home/a.md');
        expect(paths).toContain('/home/b.txt');
    });

    it('filters by glob pattern', async () => {
        write(root, 'notes.md', 'notes');
        write(root, 'data.json', 'data');
        const r = await call(sandbox, 'find', { path: '/home', pattern: '*.md' });
        const paths = r.results.map((x: any) => x.path);
        expect(paths).toContain('/home/notes.md');
        expect(paths).not.toContain('/home/data.json');
    });

    it('filters by type "f" (files only)', async () => {
        write(root, 'file.md', 'x');
        const r = await call(sandbox, 'find', { path: '/home', type: 'f' });
        const types = r.results.map((x: any) => x.type);
        expect(types.every((t: string) => t === 'f')).toBe(true);
        expect(r.results.some((x: any) => x.path === '/home/file.md')).toBe(true);
    });

    it('filters by type "d" (directories only)', async () => {
        fs.mkdirSync(path.join(root, 'home', 'subdir'), { recursive: true });
        write(root, 'file.md', 'x');
        const r = await call(sandbox, 'find', { path: '/home', type: 'd' });
        const types = r.results.map((x: any) => x.type);
        expect(types.every((t: string) => t === 'd')).toBe(true);
    });

    it('finds files recursively', async () => {
        fs.mkdirSync(path.join(root, 'home', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'nested', 'deep.md'), 'deep', 'utf-8');
        const r = await call(sandbox, 'find', { path: '/home', pattern: '*.md' });
        const paths = r.results.map((x: any) => x.path);
        expect(paths).toContain('/home/nested/deep.md');
    });

    it('throws for a non-existent directory', async () => {
        await expect(call(sandbox, 'find', { path: '/home/missing' })).rejects.toThrow(/No such file/);
    });

    it('throws when path is a file, not a directory', async () => {
        write(root, 'file.md', 'x');
        await expect(call(sandbox, 'find', { path: '/home/file.md' })).rejects.toThrow(/not a directory/);
    });

    it('throws for invalid type filter', async () => {
        await expect(call(sandbox, 'find', { path: '/home', type: 'x' })).rejects.toThrow(/"type" must be/);
    });

    it('returns truncated=false when results fit within limit', async () => {
        write(root, 'only.md', 'x');
        const r = await call(sandbox, 'find', { path: '/home' });
        expect(r.truncated).toBe(false);
    });
});

// ─── text/grep ────────────────────────────────────────────────────

describe('text/grep', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('finds pattern across multiple files', async () => {
        write(root, 'a.md', 'hello world\nnothing here\n');
        write(root, 'b.md', 'foo bar\nhello again\n');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: 'hello' });
        expect(r.matches).toHaveLength(2);
        const files = r.matches.map((m: any) => m.file);
        expect(files).toContain('/home/a.md');
        expect(files).toContain('/home/b.md');
        expect(r.truncated).toBe(false);
    });

    it('includes correct line numbers', async () => {
        write(root, 'f.md', 'line one\nline two\ntarget line\nline four\n');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: 'target' });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].line).toBe(3);
        expect(r.matches[0].text).toBe('target line');
    });

    it('filters by file glob', async () => {
        write(root, 'notes.md', 'hello notes\n');
        write(root, 'data.json', 'hello data\n');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: 'hello', glob: '*.md' });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].file).toContain('.md');
    });

    it('supports case-insensitive search', async () => {
        write(root, 'f.md', 'Hello World\nhello world\n');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: 'HELLO', case_sensitive: false });
        expect(r.matches).toHaveLength(2);
    });

    it('supports regex patterns', async () => {
        write(root, 'f.md', 'foo123\nbar456\nbaz789\n');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: '\\d{3}', regex: true });
        expect(r.matches).toHaveLength(3);
    });

    it('returns empty when no match found', async () => {
        write(root, 'f.md', 'nothing here\n');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: 'missing' });
        expect(r.matches).toHaveLength(0);
        expect(r.truncated).toBe(false);
    });

    it('searches recursively into subdirectories', async () => {
        fs.mkdirSync(path.join(root, 'home', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'sub', 'deep.md'), 'deep match here\n', 'utf-8');
        const r = await call(sandbox, 'grep', { path: '/home', pattern: 'deep match' });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].file).toBe('/home/sub/deep.md');
    });

    it('throws on ReDoS-suspect regex', async () => {
        write(root, 'f.md', 'content\n');
        await expect(
            call(sandbox, 'grep', { path: '/home', pattern: '(a+)+', regex: true }),
        ).rejects.toThrow(/nested quantifiers/);
    });

    it('throws when path is a file, not a directory', async () => {
        write(root, 'f.md', 'x');
        await expect(call(sandbox, 'grep', { path: '/home/f.md', pattern: 'x' })).rejects.toThrow(/not a directory/);
    });
});

// ─── text/tree ────────────────────────────────────────────────────

describe('text/tree', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('renders a basic tree with files and dirs', async () => {
        write(root, 'notes.md', 'n');
        fs.mkdirSync(path.join(root, 'home', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'sub', 'plan.md'), 'p', 'utf-8');
        const r = await call(sandbox, 'tree', { path: '/home' });
        expect(r.output).toContain('/home');
        expect(r.output).toContain('sub/');
        expect(r.output).toContain('plan.md');
        expect(r.output).toContain('notes.md');
    });

    it('annotates directories with index.md', async () => {
        fs.mkdirSync(path.join(root, 'home', 'project'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'project', 'index.md'), '# Project', 'utf-8');
        fs.mkdirSync(path.join(root, 'home', 'empty'), { recursive: true });
        const r = await call(sandbox, 'tree', { path: '/home' });
        expect(r.output).toContain('project/  [index.md]');
        expect(r.output).not.toContain('empty/  [index.md]');
    });

    it('uses tree connectors (├── and └──)', async () => {
        write(root, 'a.md', '');
        write(root, 'b.md', '');
        const r = await call(sandbox, 'tree', { path: '/home' });
        expect(r.output).toMatch(/[├└]──/);
    });

    it('respects depth limit', async () => {
        fs.mkdirSync(path.join(root, 'home', 'l1', 'l2', 'l3'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'l1', 'l2', 'l3', 'deep.md'), 'd', 'utf-8');
        const r = await call(sandbox, 'tree', { path: '/home', depth: 2 });
        expect(r.output).toContain('l1/');
        expect(r.output).toContain('l2/');
        expect(r.output).not.toContain('deep.md');
    });

    it('returns just the root line for an empty directory', async () => {
        const r = await call(sandbox, 'tree', { path: '/home' });
        expect(r.output.trim()).toBe('/home');
    });

    it('skips hidden files', async () => {
        fs.writeFileSync(path.join(root, 'home', '.hidden'), 'x', 'utf-8');
        write(root, 'visible.md', 'v');
        const r = await call(sandbox, 'tree', { path: '/home' });
        expect(r.output).not.toContain('.hidden');
        expect(r.output).toContain('visible.md');
    });

    it('throws for depth out of range', async () => {
        await expect(call(sandbox, 'tree', { path: '/home', depth: 0 })).rejects.toThrow(/depth/);
        await expect(call(sandbox, 'tree', { path: '/home', depth: 11 })).rejects.toThrow(/depth/);
    });

    it('throws when path is a file', async () => {
        write(root, 'f.md', 'x');
        await expect(call(sandbox, 'tree', { path: '/home/f.md' })).rejects.toThrow(/not a directory/);
    });
});

// ─── text/patch ──────────────────────────────────────────────────

describe('text/patch', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-patch-test-')));
        sandbox = new TestableSandbox(tmpBase);
        // Mount both packs for roundtrip tests.
        sandbox.mount(new TextToolPack(sandbox).createLayer());
        sandbox.mount(new FsToolPack(sandbox).createLayer());
        root = sandbox.root;
        cleanup = () => fs.rmSync(tmpBase, { recursive: true, force: true });
    });
    afterEach(() => cleanup());

    async function fsDiff(from: string, to: string) {
        const raw = await sandbox.execCall('fs/diff', { from, to }, '@test');
        const arrow = raw.indexOf(' \u2192 ');
        return (JSON.parse(raw.slice(arrow + 3)) as { diff: string }).diff;
    }

    it('applies a diff that adds lines', async () => {
        write(root, 'orig.md', 'line one\nline two\n');
        write(root, 'new.md',  'line one\nline two\nline three\n');
        const diff = await fsDiff('/home/orig.md', '/home/new.md');
        const r = await call(sandbox, 'patch', { path: '/home/orig.md', patch: diff });
        expect(r.lines_before).toBe(2);
        expect(r.lines_after).toBe(3);
        expect(read(root, 'orig.md')).toBe('line one\nline two\nline three\n');
    });

    it('applies a diff that removes lines', async () => {
        write(root, 'orig.md', 'line one\nline two\nline three\n');
        write(root, 'new.md',  'line one\nline three\n');
        const diff = await fsDiff('/home/orig.md', '/home/new.md');
        await call(sandbox, 'patch', { path: '/home/orig.md', patch: diff });
        expect(read(root, 'orig.md')).toBe('line one\nline three\n');
    });

    it('applies a diff that modifies lines', async () => {
        write(root, 'orig.md', 'hello world\n');
        write(root, 'new.md',  'hello earth\n');
        const diff = await fsDiff('/home/orig.md', '/home/new.md');
        const r = await call(sandbox, 'patch', { path: '/home/orig.md', patch: diff });
        expect(r.lines_before).toBe(1);
        expect(r.lines_after).toBe(1);
        expect(read(root, 'orig.md')).toBe('hello earth\n');
    });

    it('is idempotent with an empty diff (no-op)', async () => {
        write(root, 'orig.md', 'unchanged\n');
        write(root, 'copy.md', 'unchanged\n');
        const diff = await fsDiff('/home/orig.md', '/home/copy.md');
        // Empty diff: applyPatch returns original unchanged.
        await call(sandbox, 'patch', { path: '/home/orig.md', patch: diff });
        expect(read(root, 'orig.md')).toBe('unchanged\n');
    });

    it('returns correct path in result', async () => {
        write(root, 'a.txt', 'old\n');
        write(root, 'b.txt', 'new\n');
        const diff = await fsDiff('/home/a.txt', '/home/b.txt');
        const r = await call(sandbox, 'patch', { path: '/home/a.txt', patch: diff });
        expect(r.path).toBe('/home/a.txt');
    });

    it('throws for file that does not exist', async () => {
        const fakeDiff = '--- /home/missing.txt\n+++ /home/missing.txt\n@@ -1 +1 @@\n-old\n+new\n';
        await expect(call(sandbox, 'patch', { path: '/home/missing.txt', patch: fakeDiff }))
            .rejects.toThrow();
    });

    it('throws when patch does not apply cleanly', async () => {
        write(root, 'orig.md', 'completely different content\n');
        // A patch from different source content will not apply.
        const staleDiff = '--- /home/orig.md\n+++ /home/orig.md\n@@ -1 +1 @@\n-old line\n+new line\n';
        await expect(call(sandbox, 'patch', { path: '/home/orig.md', patch: staleDiff }))
            .rejects.toThrow(/apply/i);
    });

    it('throws for write-protected paths', async () => {
        const fakeDiff = '--- /data/x\n+++ /data/x\n';
        // /data is writable but /tools is not — use /tools for a write-protected test
        await expect(call(sandbox, 'patch', { path: '/tools/x', patch: fakeDiff }))
            .rejects.toThrow();
    });

    it('throws for missing "path" argument', async () => {
        await expect(call(sandbox, 'patch', { patch: '--- a\n+++ b\n' }))
            .rejects.toThrow(/"path"/);
    });

    it('throws for missing "patch" argument', async () => {
        write(root, 'f.md', 'x\n');
        await expect(call(sandbox, 'patch', { path: '/home/f.md' }))
            .rejects.toThrow(/"patch"/);
    });
});

// ── Etag (hash) guard ────────────────────────────────────────────

describe('etag hash guard', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('text/read response includes a hash field', async () => {
        write(root, 'f.md', 'hello\n');
        const r = await call(sandbox, 'read', { path: '/home/f.md' });
        expect(typeof r.hash).toBe('string');
        expect(r.hash).toHaveLength(32); // MD5 hex
    });

    it('same content always produces the same hash', async () => {
        write(root, 'a.md', 'same content\n');
        write(root, 'b.md', 'same content\n');
        const ra = await call(sandbox, 'read', { path: '/home/a.md' });
        const rb = await call(sandbox, 'read', { path: '/home/b.md' });
        expect(ra.hash).toBe(rb.hash);
    });

    it('text/write returns hash of the written file', async () => {
        const r = await call(sandbox, 'write', { path: '/home/new.md', content: 'hi\n' });
        expect(typeof r.hash).toBe('string');
        expect(r.hash).toHaveLength(32);
    });

    it('text/write with correct if_hash succeeds', async () => {
        write(root, 'f.md', 'original\n');
        const { hash } = await call(sandbox, 'read', { path: '/home/f.md' });
        const r = await call(sandbox, 'write', { path: '/home/f.md', content: 'updated\n', if_hash: hash });
        expect(r.ok).toBe(true);
    });

    it('text/write with stale if_hash returns stale error', async () => {
        write(root, 'f.md', 'v1\n');
        const { hash } = await call(sandbox, 'read', { path: '/home/f.md' });
        // Modify the file externally so the hash is now stale.
        fs.writeFileSync(path.join(root, 'home', 'f.md'), 'v2\n');
        const r = await call(sandbox, 'write', { path: '/home/f.md', content: 'v3\n', if_hash: hash });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('stale');
        expect(typeof r.current_hash).toBe('string');
        // The file should still contain v2 (write was rejected).
        expect(fs.readFileSync(path.join(root, 'home', 'f.md'), 'utf-8')).toBe('v2\n');
    });

    it('text/replace with stale if_hash returns stale error', async () => {
        write(root, 'f.md', 'hello world\n');
        const { hash } = await call(sandbox, 'read', { path: '/home/f.md' });
        fs.writeFileSync(path.join(root, 'home', 'f.md'), 'modified\n');
        const r = await call(sandbox, 'replace', { path: '/home/f.md', old: 'hello', new: 'hi', if_hash: hash });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('stale');
    });
});

// ── validate flag ────────────────────────────────────────────────

describe('validate flag on write tools', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('text/write with validate:true and documented file returns empty violations', async () => {
        // write() places files under {root}/home/ — so index.md lands at /home/index.md
        write(root, 'index.md', '# Home\n- notes.md\n');
        const r = await call(sandbox, 'write', { path: '/home/notes.md', content: 'hi\n', validate: true });
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
    });

    it('text/write with validate:true and undocumented file returns MANIFEST_UNDOC', async () => {
        write(root, 'index.md', '# Home\n'); // does not mention notes.md
        const r = await call(sandbox, 'write', { path: '/home/notes.md', content: 'hi\n', validate: true });
        expect(r.ok).toBe(true); // write succeeded
        expect(r.violations.length).toBeGreaterThan(0);
        expect(r.violations[0].rule).toBe('MANIFEST_UNDOC');
    });

    it('text/write without validate flag has no violations field', async () => {
        write(root, 'f.md', 'x\n');
        const r = await call(sandbox, 'write', { path: '/home/f.md', content: 'y\n' });
        expect(r.violations).toBeUndefined();
    });
});

// ── text/section ─────────────────────────────────────────────────

const NOVEL = [
    '# The Static Cage',
    '',
    'Preamble text.',
    '',
    '## Act I: The Integrity Leak',
    '',
    'Act one body.',
    '',
    '### Scene 1: System Integrity',
    '',
    'Scene one prose goes here.',
    'Second line of scene one.',
    '',
    '### Scene 2: The Drift',
    '',
    'Scene two prose.',
    '',
    '## Act II: Collapse',
    '',
    'Act two body.',
    '',
].join('\n');

describe('text/section', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        write(root, 'novel.md', NOVEL);
    });
    afterEach(() => cleanup());

    it('reads a level-2 section body', async () => {
        const r = await call(sandbox, 'section', { path: '/home/novel.md', heading: '## Act I: The Integrity Leak' });
        expect(r.heading_text).toBe('## Act I: The Integrity Leak');
        expect(r.content).toContain('Act one body.');
        expect(r.content).not.toContain('Act two body.'); // stops before Act II
    });

    it('reads a level-3 section body', async () => {
        const r = await call(sandbox, 'section', { path: '/home/novel.md', heading: '### Scene 1: System Integrity' });
        expect(r.content).toContain('Scene one prose goes here.');
        expect(r.content).not.toContain('Scene two prose.'); // stops at Scene 2
    });

    it('matches by bare text (without # prefix)', async () => {
        const r = await call(sandbox, 'section', { path: '/home/novel.md', heading: 'Scene 2: The Drift' });
        expect(r.heading_text).toBe('### Scene 2: The Drift');
        expect(r.content).toContain('Scene two prose.');
    });

    it('returns hash and correct line numbers', async () => {
        const r = await call(sandbox, 'section', { path: '/home/novel.md', heading: '## Act II: Collapse' });
        expect(typeof r.hash).toBe('string');
        expect(r.hash).toHaveLength(32);
        expect(r.heading_line).toBeGreaterThan(0);
        expect(r.to_line).toBeGreaterThanOrEqual(r.from_line);
    });

    it('reads to end of file when section is last', async () => {
        const r = await call(sandbox, 'section', { path: '/home/novel.md', heading: '## Act II: Collapse' });
        expect(r.content).toContain('Act two body.');
    });

    it('throws for an unknown heading', async () => {
        await expect(
            call(sandbox, 'section', { path: '/home/novel.md', heading: '## Non-existent' })
        ).rejects.toThrow(/not found/i);
    });
});

// ── Home ACL ──────────────────────────────────────────────────────

describe('text/write — home ACL', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        sandbox.ensureAgentHome('@nova');
        sandbox.ensureAgentHome('@test');
    });
    afterEach(() => cleanup());

    it('allows writing to own home dir', async () => {
        const r = await call(sandbox, 'write', { path: '/home/test/file.md', content: 'hi' });
        expect(r.ok).toBe(true);
    });

    it('rejects write to another agent home', async () => {
        await expect(
            call(sandbox, 'write', { path: '/home/nova/evil.md', content: 'x' })
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects write to nested path inside another agent home', async () => {
        await expect(
            call(sandbox, 'write', { path: '/home/nova/subdir/file.md', content: 'x' })
        ).rejects.toThrow(/Permission denied/);
    });

    it('allows writing to /home/ root (not inside any agent dir)', async () => {
        // /home/notes.md is not inside any agent subdirectory — no ownership applies
        const r = await call(sandbox, 'write', { path: '/home/notes.md', content: 'hi' });
        expect(r.ok).toBe(true);
    });
});
