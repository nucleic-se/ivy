/**
 * Tests for BatchToolPack — batch/apply with file-level rollback.
 * Also covers validate/gate behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { BatchToolPack } from '../src/packs/BatchToolPack.js';
import { TextToolPack } from '../src/packs/TextToolPack.js';
import { LedgerToolPack } from '../src/packs/LedgerToolPack.js';
import { ValidateToolPack } from '../src/packs/ValidateToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-batch-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new TextToolPack(sandbox).createLayer());
    sandbox.mount(new LedgerToolPack(sandbox).createLayer());
    sandbox.mount(new ValidateToolPack(sandbox).createLayer());
    sandbox.mount(new BatchToolPack(sandbox).createLayer());
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

function makeLedger(tasks: Array<{ id: string; status: string }>) {
    return JSON.stringify({
        project: 'Test',
        version: '1.0.0',
        tasks: tasks.map(t => ({ description: t.id, owner: null, dependencies: [], validation_hash: null, lock: null, ...t })),
    }, null, 2);
}

async function apply(sandbox: Sandbox, ops: unknown[], caller = '@nova') {
    const raw = await sandbox.execCall('batch/apply', { ops }, caller);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as {
        status: 'ok' | 'rolled_back';
        completed: number;
        total: number;
        failed_at?: number;
        error?: string;
        rolled_back: number;
    };
}

// ─── Success cases ───────────────────────────────────────────────

describe('batch/apply — success', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('executes all ops and returns ok', async () => {
        write(root, 'data/a.md', 'hello\n');
        write(root, 'data/b.md', 'world\n');

        const r = await apply(sandbox, [
            { tool: 'text/replace', args: { path: '/data/a.md', old: 'hello', new: 'hi' } },
            { tool: 'text/replace', args: { path: '/data/b.md', old: 'world', new: 'earth' } },
        ]);

        expect(r.status).toBe('ok');
        expect(r.completed).toBe(2);
        expect(r.rolled_back).toBe(0);
        expect(read(root, 'data/a.md')).toContain('hi');
        expect(read(root, 'data/b.md')).toContain('earth');
    });

    it('returns ok for a single op', async () => {
        write(root, 'data/note.md', 'draft\n');
        const r = await apply(sandbox, [
            { tool: 'text/replace', args: { path: '/data/note.md', old: 'draft', new: 'final' } },
        ]);
        expect(r.status).toBe('ok');
        expect(r.total).toBe(1);
    });

    it('ledger/update works inside a batch', async () => {
        write(root, 'data/ledger.json', makeLedger([{ id: 'T1', status: 'pending' }]));
        const r = await apply(sandbox, [
            { tool: 'ledger/update', args: { ledger_path: '/data/ledger.json', task_id: 'T1', status: 'active' } },
        ]);
        expect(r.status).toBe('ok');
        const ledger = JSON.parse(read(root, 'data/ledger.json'));
        expect(ledger.tasks[0].status).toBe('active');
    });
});

// ─── Rollback cases ──────────────────────────────────────────────

describe('batch/apply — rollback on failure', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('rolls back file changes when a later op fails', async () => {
        write(root, 'data/a.md', 'original\n');

        const r = await apply(sandbox, [
            { tool: 'text/replace', args: { path: '/data/a.md', old: 'original', new: 'modified' } },
            { tool: 'text/replace', args: { path: '/data/a.md', old: 'NO_MATCH', new: 'boom' } }, // will fail
        ]);

        expect(r.status).toBe('rolled_back');
        expect(r.completed).toBe(1);
        expect(r.failed_at).toBe(1);
        expect(r.error).toBeDefined();
        // a.md should be restored to original
        expect(read(root, 'data/a.md')).toContain('original');
    });

    it('rolls back multi-file changes when op N fails', async () => {
        write(root, 'data/a.md', 'alpha\n');
        write(root, 'data/b.md', 'beta\n');

        const r = await apply(sandbox, [
            { tool: 'text/replace', args: { path: '/data/a.md', old: 'alpha', new: 'ALPHA' } },
            { tool: 'text/replace', args: { path: '/data/b.md', old: 'beta', new: 'BETA' } },
            { tool: 'text/replace', args: { path: '/data/b.md', old: 'BOGUS', new: 'x' } }, // fails
        ]);

        expect(r.status).toBe('rolled_back');
        // Both a.md and b.md should be restored.
        expect(read(root, 'data/a.md')).toBe('alpha\n');
        expect(read(root, 'data/b.md')).toBe('beta\n');
    });

    it('deletes a newly-created file on rollback', async () => {
        write(root, 'data/existing.md', 'unchanged\n');

        const r = await apply(sandbox, [
            { tool: 'text/write', args: { path: '/data/new.md', content: 'created' } },
            { tool: 'text/replace', args: { path: '/data/existing.md', old: 'NO_MATCH', new: 'x' } }, // fails
        ]);

        expect(r.status).toBe('rolled_back');
        // New file should be deleted.
        expect(exists(root, 'data/new.md')).toBe(false);
        // Existing file should be unchanged.
        expect(read(root, 'data/existing.md')).toBe('unchanged\n');
    });

    it('reports correct failed_at index (0-based)', async () => {
        write(root, 'data/a.md', 'ok\n');

        const r = await apply(sandbox, [
            { tool: 'text/replace', args: { path: '/data/a.md', old: 'BOGUS', new: 'x' } },
        ]);

        expect(r.status).toBe('rolled_back');
        expect(r.failed_at).toBe(0);
        expect(r.completed).toBe(0);
    });

    it('rolls back ledger update on later failure', async () => {
        write(root, 'data/ledger.json', makeLedger([{ id: 'T1', status: 'pending' }]));
        write(root, 'data/a.md', 'original\n');

        const r = await apply(sandbox, [
            { tool: 'ledger/update', args: { ledger_path: '/data/ledger.json', task_id: 'T1', status: 'active' } },
            { tool: 'text/replace', args: { path: '/data/a.md', old: 'BOGUS', new: 'x' } }, // fails
        ]);

        expect(r.status).toBe('rolled_back');
        const ledger = JSON.parse(read(root, 'data/ledger.json'));
        expect(ledger.tasks[0].status).toBe('pending'); // rolled back
    });
});

// ─── Input validation ────────────────────────────────────────────

describe('batch/apply — input validation', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('throws when ops is not an array', async () => {
        await expect(apply(sandbox, 'not-an-array' as any)).rejects.toThrow(/"ops" must be an array/);
    });

    it('throws when ops is empty', async () => {
        await expect(apply(sandbox, [])).rejects.toThrow(/must not be empty/);
    });

    it('throws when ops exceeds MAX_OPS', async () => {
        const ops = Array.from({ length: 21 }, (_, i) => ({
            tool: 'text/write',
            args: { path: `/tmp/f${i}.md`, content: 'x' },
        }));
        await expect(apply(sandbox, ops)).rejects.toThrow(/too many ops/i);
    });

    it('throws when an op is missing tool', async () => {
        await expect(apply(sandbox, [{ args: {} }])).rejects.toThrow(/tool/);
    });
});

// ─── validate/gate ───────────────────────────────────────────────

describe('validate/gate', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    async function gate(agentPath: string, checks?: string) {
        const args: Record<string, unknown> = { path: agentPath };
        if (checks) args['checks'] = checks;
        const raw = await sandbox.execCall('validate/gate', args, '@sentinel');
        const arrow = raw.indexOf(' → ');
        return JSON.parse(raw.slice(arrow + 3));
    }

    it('passes for a compliant path', async () => {
        write(root, 'home/index.md', '# Home\n- `notes.md`: Notes.\n');
        write(root, 'home/notes.md', '# Notes\n');
        const r = await gate('/home');
        expect(r.status).toBe('pass');
        expect(r.summary.violations).toBe(0);
    });

    it('gate returns { status, summary } on pass', async () => {
        write(root, 'home/index.md', '# Home\n- `notes.md`: Notes.\n');
        write(root, 'home/notes.md', '# Notes\n');
        const r = await gate('/home');
        expect(r.status).toBe('pass');
        expect(typeof r.summary).toBe('object');
        expect(r.summary.violations).toBe(0);
    });

    it('throws when violations exist', async () => {
        fs.mkdirSync(path.join(root, 'home', 'noindex'), { recursive: true });
        await expect(gate('/home', 'index')).rejects.toThrow(/validation gate failed/i);
    });

    it('error message includes the violation rule and path', async () => {
        fs.mkdirSync(path.join(root, 'home', 'noindex'), { recursive: true });
        const err = await gate('/home', 'index').catch((e: Error) => e);
        expect((err as Error).message).toContain('INDEX_MISSING');
    });

    it('batch/apply rolls back when validate/gate fails', async () => {
        write(root, 'home/index.md', '# Home\n');
        write(root, 'home/notes.md', 'draft\n');

        // Batch: modify notes.md then run gate — gate will fail (notes.md undocumented in index.md)
        const r = await apply(sandbox, [
            { tool: 'text/replace', args: { path: '/home/notes.md', old: 'draft', new: 'modified' } },
            { tool: 'validate/gate', args: { path: '/home', checks: 'manifest' } },
        ]);

        expect(r.status).toBe('rolled_back');
        expect(read(root, 'home/notes.md')).toBe('draft\n'); // rolled back
    });
});
