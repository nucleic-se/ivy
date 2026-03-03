/**
 * Tests for LedgerToolPack — ledger/query and ledger/update.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { LedgerToolPack } from '../src/packs/LedgerToolPack.js';
import type { LedgerTask } from '../src/packs/LedgerToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-ledger-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new LedgerToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

function writeLedger(root: string, agentPath: string, tasks: Partial<LedgerTask>[]) {
    const real = path.join(root, agentPath);
    fs.mkdirSync(path.dirname(real), { recursive: true });
    const ledger = {
        project: 'TestProject',
        version: '1.0.0',
        tasks: tasks.map((t, i) => ({
            id: `T${i + 1}`,
            description: `Task ${i + 1}`,
            status: 'pending',
            owner: null,
            dependencies: [],
            validation_hash: null,
            lock: null,
            ...t,
        })),
    };
    fs.writeFileSync(real, JSON.stringify(ledger, null, 2), 'utf-8');
    return agentPath;
}

async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>, caller = '@nova') {
    const raw = await sandbox.execCall(tool, args, caller);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3));
}

// ─── ledger/query ────────────────────────────────────────────────

describe('ledger/query', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns all tasks when no filters applied', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'active' },
            { id: 'T3', status: 'completed' },
        ]);
        const r = await call(sandbox, 'ledger/query', { ledger_path: `/${lp}` });
        expect(r.total).toBe(3);
        expect(r.count).toBe(3);
    });

    it('filters by status', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'active' },
            { id: 'T3', status: 'pending' },
        ]);
        const r = await call(sandbox, 'ledger/query', { ledger_path: `/${lp}`, status: 'pending' });
        expect(r.count).toBe(2);
        expect(r.total).toBe(3);
        expect(r.tasks.every((t: LedgerTask) => t.status === 'pending')).toBe(true);
    });

    it('filters by owner', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', owner: '@nova' },
            { id: 'T2', owner: '@ivy' },
            { id: 'T3', owner: '@nova' },
        ]);
        const r = await call(sandbox, 'ledger/query', { ledger_path: `/${lp}`, owner: '@nova' });
        expect(r.count).toBe(2);
        expect(r.tasks.every((t: LedgerTask) => t.owner === '@nova')).toBe(true);
    });

    it('blocked_only returns only tasks with unmet deps', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'completed' },
            { id: 'T2', status: 'pending', dependencies: ['T1'] }, // dep met
            { id: 'T3', status: 'pending', dependencies: ['T4'] }, // dep unmet
            { id: 'T4', status: 'pending' },
        ]);
        const r = await call(sandbox, 'ledger/query', { ledger_path: `/${lp}`, blocked_only: true });
        expect(r.count).toBe(1);
        expect(r.tasks[0].id).toBe('T3');
    });

    it('combines status and owner filters', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'active', owner: '@nova' },
            { id: 'T2', status: 'pending', owner: '@nova' },
            { id: 'T3', status: 'active', owner: '@ivy' },
        ]);
        const r = await call(sandbox, 'ledger/query', { ledger_path: `/${lp}`, status: 'active', owner: '@nova' });
        expect(r.count).toBe(1);
        expect(r.tasks[0].id).toBe('T1');
    });

    it('returns project name in result', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1' }]);
        const r = await call(sandbox, 'ledger/query', { ledger_path: `/${lp}` });
        expect(r.project).toBe('TestProject');
    });

    it('throws for invalid status filter', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1' }]);
        await expect(call(sandbox, 'ledger/query', { ledger_path: `/${lp}`, status: 'bogus' })).rejects.toThrow(/invalid status/i);
    });
});

// ─── ledger/update ───────────────────────────────────────────────

describe('ledger/update — status transitions', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('transitions pending → active', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'active' });
        expect(r.task.status).toBe('active');
        expect(r.transition).toBe('pending→active');
    });

    it('transitions active → completed', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'completed' });
        expect(r.task.status).toBe('completed');
        expect(r.transition).toBe('active→completed');
    });

    it('rejects pending → completed (skip active)', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        await expect(call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'completed' }))
            .rejects.toThrow(/invalid transition/i);
    });

    it('rejects completed → active (backward)', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'completed' }]);
        await expect(call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'active' }))
            .rejects.toThrow(/invalid transition/i);
    });

    it('rejects activation when dependencies are unmet', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'pending', dependencies: ['T1'] },
        ]);
        await expect(call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T2', status: 'active' }))
            .rejects.toThrow(/unmet dependencies/i);
    });

    it('allows activation when all dependencies are completed', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'completed' },
            { id: 'T2', status: 'pending', dependencies: ['T1'] },
        ]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T2', status: 'active' });
        expect(r.task.status).toBe('active');
    });

    it('persists change to disk', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'active' });
        const raw = JSON.parse(fs.readFileSync(path.join(root, lp), 'utf-8'));
        expect(raw.tasks[0].status).toBe('active');
    });

    it('appends history entry on transition', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'active' }, '@ivy');
        const raw = JSON.parse(fs.readFileSync(path.join(root, lp), 'utf-8'));
        expect(Array.isArray(raw.history)).toBe(true);
        expect(raw.history[0].by).toBe('@ivy');
        expect(raw.history[0].from).toBe('pending');
        expect(raw.history[0].to).toBe('active');
    });

    it('does not append history when only non-status fields updated', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', owner: '@nova' });
        const raw = JSON.parse(fs.readFileSync(path.join(root, lp), 'utf-8'));
        expect(raw.history ?? []).toHaveLength(0);
    });

    it('throws for unknown task_id', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1' }]);
        await expect(call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'GHOST', status: 'active' }))
            .rejects.toThrow(/task not found/i);
    });
});

describe('ledger/update — lock semantics', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('agent can acquire lock on an unlocked task', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', lock: '@nova' }, '@nova');
        expect(r.task.lock).toBe('@nova');
    });

    it('lock holder can update the task', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active', lock: '@nova' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'completed' }, '@nova');
        expect(r.task.status).toBe('completed');
    });

    it('non-lock-holder is rejected', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active', lock: '@nova' }]);
        await expect(call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', status: 'completed' }, '@ivy'))
            .rejects.toThrow(/locked by @nova/i);
    });

    it('lock holder can release lock', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active', lock: '@nova' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', lock: null }, '@nova');
        expect(r.task.lock).toBeNull();
    });

    it('rejects non-string, non-null lock value', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active' }]);
        await expect(call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', lock: 42 }))
            .rejects.toThrow(/"lock" must be/i);
    });
});

describe('ledger/update — field updates', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('sets owner', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', owner: '@ivy' });
        expect(r.task.owner).toBe('@ivy');
    });

    it('sets validation_hash', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'active' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', validation_hash: 'abc123' });
        expect(r.task.validation_hash).toBe('abc123');
    });

    it('sets notes', async () => {
        const lp = writeLedger(root, 'data/project.json', [{ id: 'T1', status: 'pending' }]);
        const r = await call(sandbox, 'ledger/update', { ledger_path: `/${lp}`, task_id: 'T1', notes: 'see spec v2' });
        expect(r.task.notes).toBe('see spec v2');
    });
});

// ─── ledger/reconcile ────────────────────────────────────────────

describe('ledger/reconcile — detection', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns clean for a valid ledger', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'completed', owner: '@nova' },
            { id: 'T2', status: 'active', owner: '@ivy', dependencies: ['T1'] },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        expect(r.status).toBe('clean');
        expect(r.violations).toHaveLength(0);
        expect(r.summary.violations).toBe(0);
    });

    it('detects ORPHAN_ACTIVE (active task with no owner)', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'active', owner: null },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        expect(r.status).toBe('violations');
        const v = r.violations.find((v: { rule: string }) => v.rule === 'ORPHAN_ACTIVE');
        expect(v).toBeDefined();
        expect(v.task_id).toBe('T1');
    });

    it('detects STALE_LOCK (lock set on non-active task)', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending', lock: '@nova' },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        const v = r.violations.find((v: { rule: string }) => v.rule === 'STALE_LOCK');
        expect(v).toBeDefined();
        expect(v.task_id).toBe('T1');
    });

    it('detects STALE_LOCK on completed task', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'completed', lock: '@ivy' },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        const v = r.violations.find((v: { rule: string }) => v.rule === 'STALE_LOCK');
        expect(v).toBeDefined();
    });

    it('detects DEP_VIOLATION (completed task has incomplete dep)', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'active', owner: '@ivy' },
            { id: 'T2', status: 'completed', dependencies: ['T1'] },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        const v = r.violations.find((v: { rule: string }) => v.rule === 'DEP_VIOLATION');
        expect(v).toBeDefined();
        expect(v.task_id).toBe('T2');
    });

    it('detects ACTIVE_BLOCKED (active task has incomplete dep)', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'active', owner: '@ivy', dependencies: ['T1'] },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        const v = r.violations.find((v: { rule: string }) => v.rule === 'ACTIVE_BLOCKED');
        expect(v).toBeDefined();
        expect(v.task_id).toBe('T2');
    });

    it('detects DUPLICATE_ID', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending' },
            { id: 'T1', status: 'active', owner: '@ivy' }, // duplicate
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        const v = r.violations.find((v: { rule: string }) => v.rule === 'DUPLICATE_ID');
        expect(v).toBeDefined();
        expect(v.task_id).toBe('T1');
    });

    it('returns tasks_checked in summary', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'pending' },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}` });
        expect(r.summary.tasks_checked).toBe(2);
    });
});

describe('ledger/reconcile — repair mode', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('repair=true resets ORPHAN_ACTIVE to pending', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'active', owner: null },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}`, repair: true });
        expect(r.repaired).toBe(1);
        const raw = JSON.parse(fs.readFileSync(path.join(root, lp), 'utf-8'));
        expect(raw.tasks[0].status).toBe('pending');
    });

    it('repair=true clears STALE_LOCK', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'pending', lock: '@nova' },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}`, repair: true });
        expect(r.repaired).toBe(1);
        const raw = JSON.parse(fs.readFileSync(path.join(root, lp), 'utf-8'));
        expect(raw.tasks[0].lock).toBeNull();
    });

    it('repair=true still reports violations (not silent)', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'active', owner: null },
        ]);
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}`, repair: true });
        expect(r.violations).toHaveLength(1); // violation still reported even after repair
    });

    it('repair=false does not modify file', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'active', owner: null },
        ]);
        const before = fs.readFileSync(path.join(root, lp), 'utf-8');
        await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}`, repair: false });
        const after = fs.readFileSync(path.join(root, lp), 'utf-8');
        expect(after).toBe(before);
    });

    it('repair=true does not write when no repairable violations', async () => {
        const lp = writeLedger(root, 'data/project.json', [
            { id: 'T1', status: 'completed', owner: null, dependencies: ['T2'] }, // DEP_VIOLATION only — not auto-fixable
            { id: 'T2', status: 'pending' },
        ]);
        const before = fs.readFileSync(path.join(root, lp), 'utf-8');
        const r = await call(sandbox, 'ledger/reconcile', { ledger_path: `/${lp}`, repair: true });
        expect(r.repaired).toBe(0);
        const after = fs.readFileSync(path.join(root, lp), 'utf-8');
        expect(after).toBe(before);
    });
});
