/**
 * Tests for FsToolPack — file-system tools.
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

// ─── fs/rm ───────────────────────────────────────────────────────

describe('fs/rm', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('deletes a file', async () => {
        sandbox.ensureAgentHome('@ivy');
        write(root, 'ivy/note.txt', 'bye\n');
        const raw = await sandbox.execCall('fs/rm', { path: '/home/ivy/note.txt' }, '@ivy');
        expect(raw).toContain('ok');
        expect(fs.existsSync(path.join(root, 'home', 'ivy', 'note.txt'))).toBe(false);
    });

    it('deletes an empty directory', async () => {
        sandbox.ensureAgentHome('@ivy');
        fs.mkdirSync(path.join(root, 'home', 'ivy', 'emptydir'), { recursive: true });
        const raw = await sandbox.execCall('fs/rm', { path: '/home/ivy/emptydir' }, '@ivy');
        expect(raw).toContain('ok');
        expect(fs.existsSync(path.join(root, 'home', 'ivy', 'emptydir'))).toBe(false);
    });

    it('deletes a non-empty directory with recursive: true', async () => {
        sandbox.ensureAgentHome('@ivy');
        fs.mkdirSync(path.join(root, 'home', 'ivy', 'subdir'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'ivy', 'subdir', 'f.txt'), 'x', 'utf-8');
        const raw = await sandbox.execCall('fs/rm', { path: '/home/ivy/subdir', recursive: true }, '@ivy');
        expect(raw).toContain('ok');
        expect(fs.existsSync(path.join(root, 'home', 'ivy', 'subdir'))).toBe(false);
    });

    it('throws when removing non-empty directory without recursive', async () => {
        sandbox.ensureAgentHome('@ivy');
        fs.mkdirSync(path.join(root, 'home', 'ivy', 'nonempty'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'ivy', 'nonempty', 'f.txt'), 'x', 'utf-8');
        await expect(sandbox.execCall('fs/rm', { path: '/home/ivy/nonempty' }, '@ivy'))
            .rejects.toThrow();
    });

    it('throws for non-existent path', async () => {
        sandbox.ensureAgentHome('@ivy');
        await expect(sandbox.execCall('fs/rm', { path: '/home/ivy/ghost.txt' }, '@ivy'))
            .rejects.toThrow();
    });

    it('throws for protected root paths', async () => {
        await expect(call(sandbox, 'rm', { path: '/home' }))
            .rejects.toThrow(/protected/i);
        await expect(call(sandbox, 'rm', { path: '/data' }))
            .rejects.toThrow(/protected/i);
        await expect(call(sandbox, 'rm', { path: '/tmp' }))
            .rejects.toThrow(/protected/i);
    });

    it('throws when agent tries to rm their own home root', async () => {
        sandbox.ensureAgentHome('@ivy');
        await expect(sandbox.execCall('fs/rm', { path: '/home/ivy', recursive: true }, '@ivy'))
            .rejects.toThrow(/protected/i);
    });

    it('rejects cross-agent home deletion', async () => {
        sandbox.ensureAgentHome('@ivy');
        sandbox.ensureAgentHome('@nova');
        write(root, 'nova/secret.txt', 'private\n');
        // @test caller (not @nova) tries to delete nova's file
        await expect(sandbox.execCall('fs/rm', { path: '/home/nova/secret.txt' }, '@ivy'))
            .rejects.toThrow(/Permission denied/i);
    });

    it('throws for missing path argument', async () => {
        await expect(call(sandbox, 'rm', {}))
            .rejects.toThrow(/"path"/);
    });

    it('throws for non-absolute path', async () => {
        await expect(call(sandbox, 'rm', { path: 'home/file.txt' }))
            .rejects.toThrow(/absolute/i);
    });
});
