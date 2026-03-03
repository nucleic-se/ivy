/**
 * Tests for SopToolPack — sop/verify.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { SopToolPack } from '../src/packs/SopToolPack.js';
import { LedgerToolPack } from '../src/packs/LedgerToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-sop-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new SopToolPack(sandbox).createLayer());
    sandbox.mount(new LedgerToolPack(sandbox).createLayer());
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

function makeLedger(tasks: Array<{ id: string; status: string; dependencies?: string[] }>) {
    return JSON.stringify({
        project: 'Test',
        version: '1.0.0',
        tasks: tasks.map(t => ({
            description: t.id,
            owner: null,
            validation_hash: null,
            lock: null,
            ...t,
        })),
    }, null, 2);
}

function makeSop(prereqIds: string[], extraSections = '') {
    const prereqs = prereqIds.length === 0
        ? '(none)'
        : prereqIds.map(id => `- [ ] Task ID: \`${id}\` (required)`).join('\n');
    return `# SOP: Test\n\n## Prerequisites\n${prereqs}\n\n## Step 1\n- **Action**: do the thing\n${extraSections}`;
}

async function call(sandbox: Sandbox, args: Record<string, unknown>) {
    const raw = await sandbox.execCall('sop/verify', args, '@nova');
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as {
        status: 'READY' | 'BLOCKED';
        task_id: string;
        reasons: string[];
        missing_deps: unknown[];
        expected_state: Record<string, string>;
    };
}

// ─── sop/verify ──────────────────────────────────────────────────

describe('sop/verify — READY cases', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns READY when all prerequisites are completed and task is pending', async () => {
        write(root, 'data/ledger.json', makeLedger([
            { id: 'prereq1', status: 'completed' },
            { id: 'T1', status: 'pending' },
        ]));
        write(root, 'data/sop.md', makeSop(['prereq1']));

        const r = await call(sandbox, {
            sop_path: '/data/sop.md',
            ledger_path: '/data/ledger.json',
            task_id: 'T1',
        });
        expect(r.status).toBe('READY');
        expect(r.reasons).toHaveLength(0);
        expect(r.missing_deps).toHaveLength(0);
    });

    it('returns READY when SOP has no prerequisites', async () => {
        write(root, 'data/ledger.json', makeLedger([{ id: 'T1', status: 'pending' }]));
        write(root, 'data/sop.md', makeSop([]));

        const r = await call(sandbox, {
            sop_path: '/data/sop.md',
            ledger_path: '/data/ledger.json',
            task_id: 'T1',
        });
        expect(r.status).toBe('READY');
    });

    it('includes expected_state in result', async () => {
        write(root, 'data/ledger.json', makeLedger([
            { id: 'dep1', status: 'completed' },
            { id: 'T1', status: 'pending' },
        ]));
        write(root, 'data/sop.md', makeSop(['dep1']));

        const r = await call(sandbox, {
            sop_path: '/data/sop.md',
            ledger_path: '/data/ledger.json',
            task_id: 'T1',
        });
        expect(r.expected_state['dep1']).toBe('completed');
        expect(r.expected_state['T1']).toBe('pending');
    });
});

describe('sop/verify — BLOCKED cases', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns BLOCKED when a prerequisite is pending', async () => {
        write(root, 'data/ledger.json', makeLedger([
            { id: 'prereq1', status: 'pending' },
            { id: 'T1', status: 'pending' },
        ]));
        write(root, 'data/sop.md', makeSop(['prereq1']));

        const r = await call(sandbox, {
            sop_path: '/data/sop.md',
            ledger_path: '/data/ledger.json',
            task_id: 'T1',
        });
        expect(r.status).toBe('BLOCKED');
        expect(r.reasons.some(s => s.includes('prereq1'))).toBe(true);
        expect(r.missing_deps).toHaveLength(1);
    });

    it('returns BLOCKED when a prerequisite is active (not yet completed)', async () => {
        write(root, 'data/ledger.json', makeLedger([
            { id: 'prereq1', status: 'active' },
            { id: 'T1', status: 'pending' },
        ]));
        write(root, 'data/sop.md', makeSop(['prereq1']));

        const r = await call(sandbox, { sop_path: '/data/sop.md', ledger_path: '/data/ledger.json', task_id: 'T1' });
        expect(r.status).toBe('BLOCKED');
    });

    it('returns BLOCKED when task is already active', async () => {
        write(root, 'data/ledger.json', makeLedger([
            { id: 'prereq1', status: 'completed' },
            { id: 'T1', status: 'active' },
        ]));
        write(root, 'data/sop.md', makeSop(['prereq1']));

        const r = await call(sandbox, { sop_path: '/data/sop.md', ledger_path: '/data/ledger.json', task_id: 'T1' });
        expect(r.status).toBe('BLOCKED');
        expect(r.reasons.some(s => s.includes('already active'))).toBe(true);
    });

    it('returns BLOCKED when task is already completed', async () => {
        write(root, 'data/ledger.json', makeLedger([{ id: 'T1', status: 'completed' }]));
        write(root, 'data/sop.md', makeSop([]));

        const r = await call(sandbox, { sop_path: '/data/sop.md', ledger_path: '/data/ledger.json', task_id: 'T1' });
        expect(r.status).toBe('BLOCKED');
        expect(r.reasons.some(s => s.includes('already completed'))).toBe(true);
    });

    it('returns BLOCKED when task_id is not in ledger', async () => {
        write(root, 'data/ledger.json', makeLedger([{ id: 'other', status: 'pending' }]));
        write(root, 'data/sop.md', makeSop([]));

        const r = await call(sandbox, { sop_path: '/data/sop.md', ledger_path: '/data/ledger.json', task_id: 'GHOST' });
        expect(r.status).toBe('BLOCKED');
        expect(r.reasons.some(s => s.includes('not found'))).toBe(true);
    });

    it('reports each unmet prerequisite separately', async () => {
        write(root, 'data/ledger.json', makeLedger([
            { id: 'dep1', status: 'pending' },
            { id: 'dep2', status: 'pending' },
            { id: 'T1', status: 'pending' },
        ]));
        write(root, 'data/sop.md', makeSop(['dep1', 'dep2']));

        const r = await call(sandbox, { sop_path: '/data/sop.md', ledger_path: '/data/ledger.json', task_id: 'T1' });
        expect(r.missing_deps).toHaveLength(2);
        expect(r.reasons.length).toBeGreaterThanOrEqual(2);
    });

    it('parses prerequisites when ## Prerequisites is the last section (no ## heading after it)', async () => {
        // SOP with Prerequisites as the LAST section — no trailing ## heading.
        const sopContent = '# SOP\n\n## Prerequisites\n- [ ] Task ID: `T1` (must complete first)\n';
        write(root, 'data/ledger.json', makeLedger([
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'pending' },
        ]));
        write(root, 'data/sop.md', sopContent);

        const r = await call(sandbox, {
            sop_path: '/data/sop.md',
            ledger_path: '/data/ledger.json',
            task_id: 'T2',
        });
        expect(r.status).toBe('BLOCKED');
        expect(r.missing_deps.some((d: { id: string }) => d.id === 'T1')).toBe(true);
    });
});
