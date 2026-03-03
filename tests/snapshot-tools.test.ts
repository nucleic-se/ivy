/**
 * Tests for SnapshotToolPack — snapshot/create, snapshot/list, snapshot/diff.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { SnapshotToolPack } from '../src/packs/SnapshotToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-snapshot-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new SnapshotToolPack(sandbox).createLayer());
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

async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>, caller = '@nova') {
    const raw = await sandbox.execCall(tool, args, caller);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3));
}

// ─── snapshot/create ─────────────────────────────────────────────

describe('snapshot/create', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns id, source_path, created_at, file_count, snapshot_path', async () => {
        write(root, 'data/proj/a.md', 'hello');
        write(root, 'data/proj/b.md', 'world');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        expect(typeof r.id).toBe('string');
        expect(r.id).toMatch(/^snap_/);
        expect(r.source_path).toBe('/data/proj');
        expect(r.file_count).toBe(2);
        expect(typeof r.created_at).toBe('string');
        expect(r.snapshot_path).toBe(`/tmp/snapshots/${r.id}`);
    });

    it('actually copies files into snapshot data dir', async () => {
        write(root, 'data/proj/note.md', 'content');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        const copied = path.join(root, 'tmp', 'snapshots', r.id, 'data', 'note.md');
        expect(fs.existsSync(copied)).toBe(true);
        expect(fs.readFileSync(copied, 'utf-8')).toBe('content');
    });

    it('writes meta.json alongside data/', async () => {
        write(root, 'data/proj/x.md', 'x');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        const metaPath = path.join(root, 'tmp', 'snapshots', r.id, 'meta.json');
        expect(fs.existsSync(metaPath)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        expect(meta.id).toBe(r.id);
        expect(meta.source_path).toBe('/data/proj');
        expect(meta.file_count).toBe(1);
    });

    it('records optional label', async () => {
        write(root, 'data/proj/a.md', 'a');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj', label: 'before-refactor' });
        expect(r.label).toBe('before-refactor');
        const metaPath = path.join(root, 'tmp', 'snapshots', r.id, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        expect(meta.label).toBe('before-refactor');
    });

    it('omits label field when not provided', async () => {
        write(root, 'data/proj/a.md', 'a');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        expect('label' in r).toBe(false);
    });

    it('skips hidden files', async () => {
        write(root, 'data/proj/visible.md', 'v');
        fs.writeFileSync(path.join(root, 'data/proj/.hidden'), 'h');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        expect(r.file_count).toBe(1);
        const hiddenCopy = path.join(root, 'tmp', 'snapshots', r.id, 'data', '.hidden');
        expect(fs.existsSync(hiddenCopy)).toBe(false);
    });

    it('handles nested directories', async () => {
        write(root, 'data/proj/src/a.ts', 'a');
        write(root, 'data/proj/src/b.ts', 'b');
        write(root, 'data/proj/README.md', 'readme');
        const r = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        expect(r.file_count).toBe(3);
    });

    it('throws when path is not a directory', async () => {
        write(root, 'data/file.md', 'content');
        await expect(call(sandbox, 'snapshot/create', { path: '/data/file.md' }))
            .rejects.toThrow(/directory/i);
    });

    it('throws when path does not exist', async () => {
        await expect(call(sandbox, 'snapshot/create', { path: '/data/nonexistent' }))
            .rejects.toThrow();
    });
});

// ─── snapshot/list ────────────────────────────────────────────────

describe('snapshot/list', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns empty list when no snapshots exist', async () => {
        const r = await call(sandbox, 'snapshot/list', {});
        expect(r.snapshots).toEqual([]);
        expect(r.count).toBe(0);
    });

    it('lists created snapshots', async () => {
        write(root, 'data/proj/a.md', 'a');
        await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        const r = await call(sandbox, 'snapshot/list', {});
        expect(r.count).toBe(1);
        expect(r.snapshots).toHaveLength(1);
        expect(r.snapshots[0].source_path).toBe('/data/proj');
    });

    it('returns count matching snapshots array length', async () => {
        write(root, 'data/proj/a.md', 'a');
        await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        const r = await call(sandbox, 'snapshot/list', {});
        expect(r.count).toBe(2);
        expect(r.snapshots).toHaveLength(2);
    });

    it('sorts newest first (by id)', async () => {
        write(root, 'data/proj/a.md', 'a');
        const r1 = await call(sandbox, 'snapshot/create', { path: '/data/proj', label: 'first' });
        const r2 = await call(sandbox, 'snapshot/create', { path: '/data/proj', label: 'second' });
        const list = await call(sandbox, 'snapshot/list', {});
        expect(list.snapshots[0].id).toBe(r2.id);
        expect(list.snapshots[1].id).toBe(r1.id);
    });

    it('skips directories without meta.json', async () => {
        // Create a rogue directory in snapshots/ without meta.json
        fs.mkdirSync(path.join(root, 'tmp', 'snapshots', 'snap_bad'), { recursive: true });
        write(root, 'data/proj/a.md', 'a');
        await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        const r = await call(sandbox, 'snapshot/list', {});
        expect(r.count).toBe(1); // Only the valid snapshot
    });
});

// ─── snapshot/diff ────────────────────────────────────────────────

describe('snapshot/diff', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('reports added files', async () => {
        write(root, 'data/proj/existing.md', 'old');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });

        // Add a new file after snapshot
        write(root, 'data/proj/new.md', 'new content');

        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        expect(r.added).toContain('new.md');
        expect(r.removed).toHaveLength(0);
    });

    it('reports removed files', async () => {
        write(root, 'data/proj/a.md', 'a');
        write(root, 'data/proj/b.md', 'b');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });

        // Remove a file after snapshot
        fs.unlinkSync(path.join(root, 'data/proj/b.md'));

        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        expect(r.removed).toContain('b.md');
        expect(r.added).toHaveLength(0);
    });

    it('reports modified files with unified diff', async () => {
        write(root, 'data/proj/a.md', 'original content\n');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });

        write(root, 'data/proj/a.md', 'modified content\n');

        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        expect(r.modified).toHaveLength(1);
        expect(r.modified[0].path).toBe('a.md');
        expect(typeof r.modified[0].diff).toBe('string');
        expect(r.modified[0].diff).toContain('original content');
        expect(r.modified[0].diff).toContain('modified content');
    });

    it('counts unchanged files', async () => {
        write(root, 'data/proj/a.md', 'unchanged');
        write(root, 'data/proj/b.md', 'also unchanged');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });

        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        expect(r.unchanged).toBe(2);
        expect(r.modified).toHaveLength(0);
        expect(r.added).toHaveLength(0);
        expect(r.removed).toHaveLength(0);
    });

    it('uses snapshot source_path as default comparison path', async () => {
        write(root, 'data/proj/a.md', 'v1');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        write(root, 'data/proj/a.md', 'v2');

        // No path arg — should default to source_path from meta
        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        expect(r.source_path).toBe('/data/proj');
        expect(r.modified).toHaveLength(1);
    });

    it('accepts explicit path override', async () => {
        write(root, 'data/proj/a.md', 'original');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });

        // Compare against a different directory
        write(root, 'data/other/a.md', 'different');
        const r = await call(sandbox, 'snapshot/diff', { id: snap.id, path: '/data/other' });
        expect(r.source_path).toBe('/data/other');
        expect(r.modified).toHaveLength(1);
    });

    it('includes id in result', async () => {
        write(root, 'data/proj/a.md', 'a');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        expect(r.id).toBe(snap.id);
    });

    it('throws when snapshot id not found', async () => {
        await expect(call(sandbox, 'snapshot/diff', { id: 'snap_bad_id' }))
            .rejects.toThrow(/snapshot not found/i);
    });

    it('handles nested file paths in diff output', async () => {
        write(root, 'data/proj/src/main.ts', 'const x = 1;');
        write(root, 'data/proj/src/util.ts', 'export function f() {}');
        const snap = await call(sandbox, 'snapshot/create', { path: '/data/proj' });
        write(root, 'data/proj/src/main.ts', 'const x = 2;');
        const r = await call(sandbox, 'snapshot/diff', { id: snap.id });
        const modifiedPaths = r.modified.map((m: { path: string }) => m.path);
        expect(modifiedPaths).toContain('src/main.ts');
        expect(r.unchanged).toBe(1); // util.ts unchanged
    });
});
