/**
 * Tests for ManifestToolPack — manifest/check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { ManifestToolPack } from '../src/packs/ManifestToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-manifest-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new ManifestToolPack(sandbox).createLayer());
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

async function check(sandbox: Sandbox, agentPath: string) {
    const raw = await sandbox.execCall('manifest/check', { path: agentPath }, '@nova');
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as {
        registered: boolean;
        name: string;
        parent_index: string;
        line?: number;
        reason?: string;
    };
}

// ─── manifest/check ──────────────────────────────────────────────

describe('manifest/check — registered', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns registered=true when name appears in parent index.md', async () => {
        write(root, 'home/index.md', '# Home\n- `notes.md`: My notes.\n');
        write(root, 'home/notes.md', '# Notes\n');

        const r = await check(sandbox, '/home/notes.md');
        expect(r.registered).toBe(true);
        expect(r.name).toBe('notes.md');
        expect(r.parent_index).toBe('/home/index.md');
        expect(r.line).toBeGreaterThan(0);
    });

    it('returns registered=true for a directory name in parent index.md', async () => {
        write(root, 'home/index.md', '# Home\n- `research/`: Research notes.\n');
        fs.mkdirSync(path.join(root, 'home', 'research'), { recursive: true });

        const r = await check(sandbox, '/home/research');
        expect(r.registered).toBe(true);
    });
});

describe('manifest/check — not registered', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns registered=false when name is absent from parent index.md', async () => {
        write(root, 'home/index.md', '# Home\n');
        write(root, 'home/notes.md', '# Notes\n');

        const r = await check(sandbox, '/home/notes.md');
        expect(r.registered).toBe(false);
        expect(r.name).toBe('notes.md');
    });

    it('returns registered=false when parent index.md does not exist', async () => {
        write(root, 'home/notes.md', '# Notes\n');

        const r = await check(sandbox, '/home/notes.md');
        expect(r.registered).toBe(false);
        expect(r.reason).toBeDefined();
    });

    it('returns correct name for deeply nested paths', async () => {
        write(root, 'home/nova/research/index.md', '# Research\n');
        write(root, 'home/nova/research/spec.md', '# Spec\n');

        const r = await check(sandbox, '/home/nova/research/spec.md');
        expect(r.name).toBe('spec.md');
        expect(r.parent_index).toBe('/home/nova/research/index.md');
        // spec.md is not mentioned in index.md
        expect(r.registered).toBe(false);
    });

    it('returns registered=true when name matches a wildcard pattern', async () => {
        write(root, 'home/diary/index.md', '# Diary\n- `*.md`: Daily entries.\n');
        write(root, 'home/diary/2026-03-02.md', '# Day 1\n');

        const r = await check(sandbox, '/home/diary/2026-03-02.md');
        expect(r.registered).toBe(true);
        expect((r as any).via_glob).toBe(true);
        expect(r.line).toBeUndefined();
    });

    it('returns registered=true when name matches a prefix wildcard', async () => {
        write(root, 'home/logs/index.md', '# Logs\n- `2026-*.md`: Log files.\n');
        write(root, 'home/logs/2026-03-01.md', 'log\n');

        const r = await check(sandbox, '/home/logs/2026-03-01.md');
        expect(r.registered).toBe(true);
        expect((r as any).via_glob).toBe(true);
    });

    it('returns registered=false for a name that does not match any wildcard', async () => {
        write(root, 'home/logs/index.md', '# Logs\n- `2026-*.md`: Log files.\n');
        write(root, 'home/logs/README.md', 'readme\n');

        const r = await check(sandbox, '/home/logs/README.md');
        expect(r.registered).toBe(false);
    });

    it('returns registered=true after name is added to index.md', async () => {
        write(root, 'home/index.md', '# Home\n');
        write(root, 'home/notes.md', '# Notes\n');

        const before = await check(sandbox, '/home/notes.md');
        expect(before.registered).toBe(false);

        // Simulate agent updating the index.
        write(root, 'home/index.md', '# Home\n- `notes.md`: My notes.\n');

        const after = await check(sandbox, '/home/notes.md');
        expect(after.registered).toBe(true);
    });
});
