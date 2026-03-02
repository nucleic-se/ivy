/**
 * Tests for FsToolPack — file-system comparison tools.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-fs-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new FsToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>) {
    const raw = await sandbox.execCall(`fs/${tool}`, args, '@test');
    const arrow = raw.indexOf(' \u2192 ');
    return JSON.parse(raw.slice(arrow + 3));
}

function write(root: string, name: string, content: string) {
    fs.writeFileSync(path.join(root, 'home', name), content, 'utf-8');
}

// ─── fs/diff ─────────────────────────────────────────────────────

describe('fs/diff', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns empty diff for identical files', async () => {
        write(root, 'a.txt', 'hello\nworld\n');
        write(root, 'b.txt', 'hello\nworld\n');
        const r = await call(sandbox, 'diff', { from: '/home/a.txt', to: '/home/b.txt' });
        expect(r.diff).toBeDefined();
        // Unified diff header present but no hunks for identical files
        expect(r.diff).toContain('--- /home/a.txt');
        expect(r.diff).toContain('+++ /home/b.txt');
        expect(r.diff).not.toContain('@@ ');
        expect(r.from).toBe('/home/a.txt');
        expect(r.to).toBe('/home/b.txt');
    });

    it('shows added lines with + prefix', async () => {
        write(root, 'a.txt', 'line one\n');
        write(root, 'b.txt', 'line one\nline two\n');
        const r = await call(sandbox, 'diff', { from: '/home/a.txt', to: '/home/b.txt' });
        expect(r.diff).toContain('+line two');
    });

    it('shows removed lines with - prefix', async () => {
        write(root, 'a.txt', 'line one\nline two\n');
        write(root, 'b.txt', 'line one\n');
        const r = await call(sandbox, 'diff', { from: '/home/a.txt', to: '/home/b.txt' });
        expect(r.diff).toContain('-line two');
    });

    it('shows modified lines as remove + add', async () => {
        write(root, 'a.txt', 'hello world\n');
        write(root, 'b.txt', 'hello earth\n');
        const r = await call(sandbox, 'diff', { from: '/home/a.txt', to: '/home/b.txt' });
        expect(r.diff).toContain('-hello world');
        expect(r.diff).toContain('+hello earth');
    });

    it('uses agent-visible paths in diff header', async () => {
        write(root, 'orig.md', '# Title\n');
        write(root, 'new.md',  '# Title\n\nContent.\n');
        const r = await call(sandbox, 'diff', { from: '/home/orig.md', to: '/home/new.md' });
        expect(r.diff).toContain('--- /home/orig.md');
        expect(r.diff).toContain('+++ /home/new.md');
    });

    it('throws for non-existent "from" file', async () => {
        write(root, 'b.txt', 'content\n');
        await expect(call(sandbox, 'diff', { from: '/home/missing.txt', to: '/home/b.txt' }))
            .rejects.toThrow();
    });

    it('throws for non-existent "to" file', async () => {
        write(root, 'a.txt', 'content\n');
        await expect(call(sandbox, 'diff', { from: '/home/a.txt', to: '/home/missing.txt' }))
            .rejects.toThrow();
    });

    it('throws if "from" is a directory', async () => {
        write(root, 'b.txt', 'content\n');
        await expect(call(sandbox, 'diff', { from: '/home', to: '/home/b.txt' }))
            .rejects.toThrow(/directory/i);
    });

    it('throws if "to" is a directory', async () => {
        write(root, 'a.txt', 'content\n');
        await expect(call(sandbox, 'diff', { from: '/home/a.txt', to: '/home' }))
            .rejects.toThrow(/directory/i);
    });

    it('throws for missing "from" argument', async () => {
        write(root, 'a.txt', 'content\n');
        await expect(call(sandbox, 'diff', { to: '/home/a.txt' }))
            .rejects.toThrow(/"from"/);
    });

    it('throws for missing "to" argument', async () => {
        write(root, 'a.txt', 'content\n');
        await expect(call(sandbox, 'diff', { from: '/home/a.txt' }))
            .rejects.toThrow(/"to"/);
    });

    it('throws for non-absolute path', async () => {
        write(root, 'a.txt', 'x\n');
        write(root, 'b.txt', 'y\n');
        await expect(call(sandbox, 'diff', { from: 'home/a.txt', to: '/home/b.txt' }))
            .rejects.toThrow(/absolute/i);
    });
});
