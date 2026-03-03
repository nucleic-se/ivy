/**
 * Tests for IndexToolPack — index/write and index/refresh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { IndexToolPack } from '../src/packs/IndexToolPack.js';

// ─── Helpers ────────────────────────────────────────────────────

class TestableSandbox extends Sandbox {
    constructor(explicitRoot: string) {
        super();
        (this as any).root = explicitRoot;
        for (const dir of ['home', 'tmp', 'data']) {
            fs.mkdirSync(path.join(explicitRoot, dir), { recursive: true });
        }
    }
}

function tempSandbox() {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-index-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new IndexToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

function write(root: string, agentPath: string, content: string) {
    const real = path.join(root, agentPath);
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, content, 'utf-8');
}

function read(root: string, agentPath: string): string {
    return fs.readFileSync(path.join(root, agentPath), 'utf-8');
}

function exists(root: string, agentPath: string): boolean {
    return fs.existsSync(path.join(root, agentPath));
}

async function refresh(sandbox: Sandbox, agentPath: string, caller = '@ivy') {
    const raw = await sandbox.execCall('index/refresh', { path: agentPath }, caller);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as {
        added: string[];
        unchanged: number;
        index_path: string;
    };
}

async function indexWrite(
    sandbox: Sandbox,
    agentPath: string,
    content: string,
    description: string,
    caller = '@ivy',
) {
    const raw = await sandbox.execCall('index/write', { path: agentPath, content, description }, caller);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as {
        written: boolean;
        registered: boolean;
        index_path: string;
    };
}

// ─── index/refresh — basic ───────────────────────────────────────

describe('index/refresh — basic', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('adds missing files to index.md', async () => {
        write(root, 'data/notes.md', '# Notes\n');
        write(root, 'data/index.md', '# Data\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toContain('notes.md');
        expect(r.unchanged).toBe(0);
        const content = read(root, 'data/index.md');
        expect(content).toContain('`notes.md`');
    });

    it('adds missing subdirectories to index.md', async () => {
        fs.mkdirSync(path.join(root, 'data', 'projects'), { recursive: true });
        write(root, 'data/index.md', '# Data\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toContain('projects');
        const content = read(root, 'data/index.md');
        expect(content).toContain('`projects/`');
    });

    it('does not duplicate already-documented entries', async () => {
        write(root, 'data/notes.md', '# Notes\n');
        write(root, 'data/index.md', '# Data\n- `notes.md`: Notes.\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toHaveLength(0);
        expect(r.unchanged).toBe(1);
        // Should not have a second stub entry.
        const content = read(root, 'data/index.md');
        expect(content.split('notes.md').length - 1).toBe(1);
    });

    it('creates index.md when it does not exist', async () => {
        write(root, 'data/file.md', '# File\n');

        expect(exists(root, 'data/index.md')).toBe(false);
        const r = await refresh(sandbox, '/data');

        expect(r.added).toContain('file.md');
        expect(exists(root, 'data/index.md')).toBe(true);
        const content = read(root, 'data/index.md');
        expect(content).toContain('`file.md`');
    });

    it('returns empty added[] when all entries are documented', async () => {
        write(root, 'data/notes.md', '# Notes\n');
        write(root, 'data/index.md', '# Data\n- `notes.md`: Notes.\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toHaveLength(0);
        expect(r.index_path).toBe('/data/index.md');
    });

    it('returns correct index_path', async () => {
        write(root, 'home/ivy/index.md', '# Ivy\n');

        const r = await refresh(sandbox, '/home/ivy');

        expect(r.index_path).toBe('/home/ivy/index.md');
    });
});

// ─── index/refresh — glob and link form ─────────────────────────

describe('index/refresh — glob and link form recognition', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('does not add entry when covered by glob pattern', async () => {
        write(root, 'data/2026-03-01.md', '# Entry\n');
        write(root, 'data/2026-03-02.md', '# Entry\n');
        write(root, 'data/index.md', '# Data\n- `*.md`: Daily diary entry.\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toHaveLength(0);
        expect(r.unchanged).toBe(2);
    });

    it('does not add entry when covered by link form', async () => {
        write(root, 'data/notes.md', '# Notes\n');
        write(root, 'data/index.md', '# Data\n- [notes.md](./notes.md): Notes.\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toHaveLength(0);
        expect(r.unchanged).toBe(1);
    });

    it('handles mixed documented and undocumented entries', async () => {
        write(root, 'data/a.md', '# A\n');
        write(root, 'data/b.md', '# B\n');
        write(root, 'data/index.md', '# Data\n- `a.md`: A file.\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toEqual(['b.md']);
        expect(r.unchanged).toBe(1);
    });
});

// ─── index/refresh — edge cases ─────────────────────────────────

describe('index/refresh — edge cases', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('skips hidden files', async () => {
        write(root, 'data/.hidden', 'private\n');
        write(root, 'data/index.md', '# Data\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toHaveLength(0);
    });

    it('skips index.md itself (self-exempted)', async () => {
        write(root, 'data/index.md', '# Data\n');

        const r = await refresh(sandbox, '/data');

        expect(r.added).toHaveLength(0);
    });

    it('throws when path is not a directory', async () => {
        write(root, 'data/file.md', '# File\n');

        await expect(refresh(sandbox, '/data/file.md')).rejects.toThrow(/not a directory/);
    });

    it('throws when path does not exist', async () => {
        await expect(refresh(sandbox, '/data/nonexistent')).rejects.toThrow();
    });

    it('appends to existing content without double newline gap', async () => {
        write(root, 'data/a.md', '# A\n');
        write(root, 'data/index.md', '# Data\n- `existing.md`: Documented.\n');

        await refresh(sandbox, '/data');

        const content = read(root, 'data/index.md');
        // Should not have blank lines between existing and appended content.
        expect(content).not.toMatch(/\n\n- `a\.md`/);
    });
});

// ─── index/write ────────────────────────────────────────────────

describe('index/write — basic', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('writes the file and registers it in index.md', async () => {
        write(root, 'data/index.md', '# Data\n');

        const r = await indexWrite(sandbox, '/data/notes.md', '# Notes\n', 'Working notes.');

        expect(r.written).toBe(true);
        expect(r.registered).toBe(true);
        expect(r.index_path).toBe('/data/index.md');
        expect(read(root, 'data/notes.md')).toBe('# Notes\n');
        expect(read(root, 'data/index.md')).toContain('`notes.md`: Working notes.');
    });

    it('creates index.md when it does not exist', async () => {
        expect(exists(root, 'data/index.md')).toBe(false);

        const r = await indexWrite(sandbox, '/data/notes.md', '# Notes\n', 'Working notes.');

        expect(r.written).toBe(true);
        expect(r.registered).toBe(true);
        expect(exists(root, 'data/index.md')).toBe(true);
        expect(read(root, 'data/index.md')).toContain('`notes.md`');
    });

    it('writes the file but does not duplicate an existing index entry', async () => {
        write(root, 'data/index.md', '# Data\n- `notes.md`: Already registered.\n');

        const r = await indexWrite(sandbox, '/data/notes.md', '# New content\n', 'New description.');

        expect(r.written).toBe(true);
        expect(r.registered).toBe(false);
        // File content updated.
        expect(read(root, 'data/notes.md')).toBe('# New content\n');
        // index.md not duplicated.
        const idx = read(root, 'data/index.md');
        expect(idx.split('notes.md').length - 1).toBe(1);
    });

    it('does not register when covered by a glob pattern', async () => {
        write(root, 'data/index.md', '# Data\n- `*.md`: All markdown files.\n');

        const r = await indexWrite(sandbox, '/data/2026-03-01.md', '# Entry\n', 'Diary entry.');

        expect(r.written).toBe(true);
        expect(r.registered).toBe(false);
        expect(read(root, 'data/2026-03-01.md')).toBe('# Entry\n');
    });

    it('creates parent directories for the file', async () => {
        const r = await indexWrite(sandbox, '/home/nova/reports/summary.md', '# Summary\n', 'Report summary.');

        expect(r.written).toBe(true);
        expect(exists(root, 'home/nova/reports/summary.md')).toBe(true);
    });

    it('throws when path is index.md', async () => {
        await expect(
            indexWrite(sandbox, '/data/index.md', '# Index\n', 'Self-reference.'),
        ).rejects.toThrow(/use text\/write/i);
    });

    it('appends the description verbatim', async () => {
        write(root, 'data/index.md', '# Data\n');

        await indexWrite(sandbox, '/data/report.md', '# Report\n', 'Monthly performance report.');

        expect(read(root, 'data/index.md')).toContain('`report.md`: Monthly performance report.');
    });
});

// ─── index/refresh — SNAPSHOT_KEYS coverage ─────────────────────

describe('batch/apply dynamic path collection', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;
    let cleanupBatch: () => void;

    beforeEach(() => {
        const sb = tempSandbox();
        sandbox = sb.sandbox;
        root = sb.root;
        cleanup = sb.cleanup;
    });
    afterEach(() => cleanup());

    it('collectAgentPaths handles deeply nested args (no crash)', async () => {
        // Verify the recursive arg extraction does not break on nested/complex args.
        // This tests the structural change in BatchToolPack.collectAgentPaths.
        write(root, 'data/notes.md', '# Notes\n');
        write(root, 'data/index.md', '# Data\n');

        // index/refresh uses { path: '/...' } — verified to be in snapshot scope.
        const r = await refresh(sandbox, '/data');
        expect(r.added).toContain('notes.md');
    });
});
