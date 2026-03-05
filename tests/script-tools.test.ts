/**
 * Tests for ScriptToolPack — Living Script task execution tools.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { ScriptToolPack } from '../src/packs/ScriptToolPack.js';

// ─── Helpers ────────────────────────────────────────────────────

class TestableSandbox extends Sandbox {
    constructor(explicitRoot: string) {
        super();
        (this as any).root = explicitRoot;
        for (const dir of ['home', 'tools', 'data', 'tmp']) {
            fs.mkdirSync(path.join(explicitRoot, dir), { recursive: true });
        }
        // Pre-create nova home so ACL is established.
        this.ensureAgentHome('nova');
    }
}

function tempSandbox() {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-script-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new ScriptToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: tmpBase,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

async function call<T = Record<string, unknown>>(
    sandbox: Sandbox,
    tool: string,
    args: Record<string, unknown>,
    caller = 'nova',
): Promise<T> {
    const raw = await sandbox.execCall(tool, args, `@${caller}`);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as T;
}

function readFile(root: string, agentPath: string): string {
    return fs.readFileSync(path.join(root, agentPath), 'utf-8');
}

const SCRIPT_PATH = '/home/nova/tasks/my-task.md';
const STEPS = JSON.stringify(['Research', 'Draft', 'Validate']);

// ─── script/create ───────────────────────────────────────────────

describe('script/create', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
    });
    afterEach(() => cleanup());

    it('creates a script file with correct structure', async () => {
        const result = await call(sandbox, 'script/create', {
            path: SCRIPT_PATH,
            title: 'My Task',
            goal: 'Do the thing.',
            steps: STEPS,
        });

        expect(result['created']).toBe(true);
        expect(result['path']).toBe(SCRIPT_PATH);
        expect(result['step_count']).toBe(3);
        expect(result['hint']).toContain('CONTEXT.md');

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('# Script: My Task');
        expect(content).toContain('Goal: Do the thing.');
        expect(content).toContain('Status: active');
        expect(content).toContain('- [/] S1: Research');
        expect(content).toContain('- [ ] S2: Draft');
        expect(content).toContain('- [ ] S3: Validate');
        expect(content).toContain('Current: S1');
        expect(content).toContain('Attempts: 0');
        expect(content).toContain('## Handoff Log');
    });

    it('registers the file in parent index.md', async () => {
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH,
            title: 'My Task',
            goal: 'Do the thing.',
            steps: STEPS,
        });

        const index = readFile(root, '/home/nova/tasks/index.md');
        expect(index).toContain('my-task.md');
        expect(index).toContain('My Task');
    });

    it('does not duplicate index entry on second create with same name', async () => {
        for (let i = 0; i < 2; i++) {
            await call(sandbox, 'script/create', {
                path: SCRIPT_PATH,
                title: 'My Task',
                goal: 'Do the thing.',
                steps: STEPS,
            });
        }
        const index = readFile(root, '/home/nova/tasks/index.md');
        const matches = (index.match(/my-task\.md/g) ?? []).length;
        expect(matches).toBe(1);
    });

    it('rejects empty steps array', async () => {
        await expect(
            call(sandbox, 'script/create', {
                path: SCRIPT_PATH,
                title: 'Bad',
                goal: 'Bad.',
                steps: '[]',
            })
        ).rejects.toThrow(/non-empty/);
    });

    it('rejects invalid steps JSON', async () => {
        await expect(
            call(sandbox, 'script/create', {
                path: SCRIPT_PATH,
                title: 'Bad',
                goal: 'Bad.',
                steps: 'not-json',
            })
        ).rejects.toThrow(/JSON array/);
    });

    it('uses caller as default owner', async () => {
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH,
            title: 'My Task',
            goal: 'Do the thing.',
            steps: STEPS,
        });
        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Owner: @nova');
    });

    it('honours explicit owner arg', async () => {
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH,
            title: 'My Task',
            goal: 'Do the thing.',
            steps: STEPS,
            owner: '@ivy',
        });
        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Owner: @ivy');
    });
});

// ─── script/status ───────────────────────────────────────────────

describe('script/status', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(async () => {
        ({ sandbox, cleanup } = tempSandbox());
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH, title: 'My Task', goal: 'Do the thing.', steps: STEPS,
        });
    });
    afterEach(() => cleanup());

    it('returns step list with markers', async () => {
        const result = await call(sandbox, 'script/status', { path: SCRIPT_PATH });

        expect(result['title']).toBe('My Task');
        expect(result['status']).toBe('active');
        expect(result['current']).toBe('S1');
        expect(result['attempts']).toBe(0);

        const steps = result['steps'] as Array<{ id: string; title: string; marker: string; state: string }>;
        expect(steps).toHaveLength(3);
        expect(steps[0]).toMatchObject({ id: 'S1', title: 'Research', marker: '[/]', state: 'current' });
        expect(steps[1]).toMatchObject({ id: 'S2', title: 'Draft', marker: '[ ]', state: 'pending' });
        expect(steps[2]).toMatchObject({ id: 'S3', title: 'Validate', marker: '[ ]', state: 'pending' });
    });
});

// ─── script/read_step ────────────────────────────────────────────

describe('script/read_step', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(async () => {
        ({ sandbox, cleanup } = tempSandbox());
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH, title: 'My Task', goal: 'Do the thing.', steps: STEPS,
        });
    });
    afterEach(() => cleanup());

    it('returns current step by default', async () => {
        const result = await call(sandbox, 'script/read_step', { path: SCRIPT_PATH });
        expect(result['step_id']).toBe('S1');
        expect(result['title']).toBe('Research');
        expect(result['marker']).toBe('[/]');
        expect((result['state'] as Record<string, unknown>)['current']).toBe('S1');
    });

    it('returns named step when specified', async () => {
        const result = await call(sandbox, 'script/read_step', { path: SCRIPT_PATH, step: 'S2' });
        expect(result['step_id']).toBe('S2');
        expect(result['title']).toBe('Draft');
    });

    it('returns null last_handoff when no handoff yet', async () => {
        const result = await call(sandbox, 'script/read_step', { path: SCRIPT_PATH });
        expect(result['last_handoff']).toBeNull();
    });

    it('throws for unknown step ID', async () => {
        await expect(
            call(sandbox, 'script/read_step', { path: SCRIPT_PATH, step: 'S99' })
        ).rejects.toThrow(/S99/);
    });

    it('returns last_handoff after advance', async () => {
        await call(sandbox, 'script/advance', {
            path: SCRIPT_PATH,
            summary: 'Research complete.',
        });
        const result = await call(sandbox, 'script/read_step', { path: SCRIPT_PATH, step: 'S1' });
        expect(result['last_handoff']).toContain('Research complete.');
    });
});

// ─── script/advance ──────────────────────────────────────────────

describe('script/advance', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(async () => {
        ({ sandbox, root, cleanup } = tempSandbox());
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH, title: 'My Task', goal: 'Do the thing.', steps: STEPS,
        });
    });
    afterEach(() => cleanup());

    it('marks current step done and advances pointer', async () => {
        const result = await call(sandbox, 'script/advance', {
            path: SCRIPT_PATH,
            summary: 'Research done.',
        });

        expect(result['advanced_from']).toBe('S1');
        expect(result['advanced_to']).toBe('S2');
        expect(result['complete']).toBe(false);

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('- [x] S1: Research');
        expect(content).toContain('- [/] S2: Draft');
        expect(content).toContain('Current: S2');
        expect(content).toContain('Attempts: 0');
    });

    it('appends handoff log entry', async () => {
        await call(sandbox, 'script/advance', {
            path: SCRIPT_PATH,
            summary: 'Research done.',
            result: 'partial',
        });

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('### S1');
        expect(content).toContain('Result: partial');
        expect(content).toContain('Summary: Research done.');
    });

    it('sets status to complete when last step advances', async () => {
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'S1 done.' });
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'S2 done.' });
        const result = await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'S3 done.' });

        expect(result['complete']).toBe(true);
        expect(result['advanced_to']).toBeNull();

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Status: complete');
        expect(content).toContain('Current: (complete)');
    });

    it('resets attempt counter on advance', async () => {
        // Fail once then advance.
        await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'oops' });
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'Recovered.' });

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Attempts: 0');
    });
});

// ─── script/fail_step ────────────────────────────────────────────

describe('script/fail_step', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(async () => {
        ({ sandbox, root, cleanup } = tempSandbox());
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH, title: 'My Task', goal: 'Do the thing.', steps: STEPS,
        });
    });
    afterEach(() => cleanup());

    it('increments attempt counter and appends handoff entry', async () => {
        const result = await call(sandbox, 'script/fail_step', {
            path: SCRIPT_PATH,
            reason: 'API down.',
        });

        expect(result['step_id']).toBe('S1');
        expect(result['attempts']).toBe(1);
        expect(result['escalate']).toBe(false);

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Attempts: 1');
        expect(content).toContain('Result: fail');
        expect(content).toContain('Reason: API down.');
    });

    it('keeps step marker as [/] after fail', async () => {
        await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'oops' });
        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('- [/] S1: Research');
    });

    it('returns escalate: true at threshold (3)', async () => {
        await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'fail 1' });
        await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'fail 2' });
        const result = await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'fail 3' });

        expect(result['escalate']).toBe(true);
        expect(result['attempts']).toBe(3);
        expect(result['escalate_hint']).toContain('@architect');
    });

    it('escalate_hint does not mention @ivy', async () => {
        await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'f1' });
        await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'f2' });
        const result = await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'f3' });
        expect(result['escalate_hint']).not.toContain('@ivy');
    });

    it('does not include escalate_hint below threshold', async () => {
        const result = await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'once' });
        expect(result['escalate_hint']).toBeUndefined();
    });

    it('throws when no active step', async () => {
        // Advance through all steps to completion.
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'S1.' });
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'S2.' });
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'S3.' });

        await expect(
            call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: 'oops' })
        ).rejects.toThrow(/No active/);
    });
});

// ─── script/set_state ────────────────────────────────────────────

describe('script/set_state', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(async () => {
        ({ sandbox, root, cleanup } = tempSandbox());
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH, title: 'My Task', goal: 'Do the thing.', steps: STEPS,
        });
    });
    afterEach(() => cleanup());

    it('updates the Scratchpad field', async () => {
        const result = await call(sandbox, 'script/set_state', {
            path: SCRIPT_PATH,
            scratchpad: 'Found 3 sources.',
        });

        expect(result['ok']).toBe(true);
        expect(result['scratchpad']).toBe('Found 3 sources.');

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Scratchpad: Found 3 sources.');
    });

    it('replaces newlines with spaces for single-line storage', async () => {
        const result = await call(sandbox, 'script/set_state', {
            path: SCRIPT_PATH,
            scratchpad: 'line1\nline2',
        });
        expect(result['scratchpad']).toBe('line1 line2');
    });

    it('truncates scratchpad exceeding 1024 bytes', async () => {
        const long = 'x'.repeat(2000);
        const result = await call(sandbox, 'script/set_state', {
            path: SCRIPT_PATH,
            scratchpad: long,
        });
        expect(Buffer.byteLength(result['scratchpad'] as string, 'utf-8')).toBeLessThanOrEqual(1100);
    });
});

// ─── script/list ─────────────────────────────────────────────────

describe('script/list', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(async () => {
        ({ sandbox, cleanup } = tempSandbox());
        // Create two scripts — one active, one complete.
        await call(sandbox, 'script/create', {
            path: '/home/nova/tasks/active-task.md',
            title: 'Active Task',
            goal: 'Do A.',
            steps: JSON.stringify(['Step A']),
        });
        await call(sandbox, 'script/create', {
            path: '/home/nova/tasks/done-task.md',
            title: 'Done Task',
            goal: 'Do B.',
            steps: JSON.stringify(['Step B']),
        });
        // Complete the second script.
        await call(sandbox, 'script/advance', {
            path: '/home/nova/tasks/done-task.md',
            summary: 'Step B finished.',
        });
    });
    afterEach(() => cleanup());

    it('returns only active scripts by default', async () => {
        const result = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
        });
        expect(result.scripts).toHaveLength(1);
        expect((result.scripts[0] as Record<string, unknown>)['title']).toBe('Active Task');
        expect((result.scripts[0] as Record<string, unknown>)['status']).toBe('active');
    });

    it('returns all scripts with status: all', async () => {
        const result = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
            status: 'all',
        });
        expect(result.scripts).toHaveLength(2);
    });

    it('returns complete scripts when filtered', async () => {
        const result = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
            status: 'complete',
        });
        expect(result.scripts).toHaveLength(1);
        expect((result.scripts[0] as Record<string, unknown>)['title']).toBe('Done Task');
    });

    it('returns path, title, status, current, attempts for each entry', async () => {
        const result = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
        });
        const s = result.scripts[0] as Record<string, unknown>;
        expect(s['path']).toBe('/home/nova/tasks/active-task.md');
        expect(s['current']).toBe('S1');
        expect(s['attempts']).toBe(0);
    });

    it('returns empty array when no scripts match', async () => {
        const result = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
            status: 'active',
        });
        // advance the active one to complete
        await call(sandbox, 'script/advance', {
            path: '/home/nova/tasks/active-task.md',
            summary: 'Step A done.',
        });
        const result2 = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
            status: 'active',
        });
        expect(result2.scripts).toHaveLength(0);
    });

    it('ignores non-script markdown files', async () => {
        // Write a plain .md file that is not a Living Script.
        const fs2 = await import('node:fs');
        const path2 = await import('node:path');
        const tasksDir = (sandbox as any).root + '/home/nova/tasks';
        fs2.writeFileSync(path2.join(tasksDir, 'notes.md'), '# Just notes\n\nSome text.\n', 'utf-8');

        const result = await call<{ scripts: unknown[] }>(sandbox, 'script/list', {
            dir: '/home/nova/tasks',
            status: 'all',
        });
        const titles = (result.scripts as Record<string, unknown>[]).map(s => s['title']);
        expect(titles).not.toContain('Just notes');
    });
});

// ─── Integration: full run-through ───────────────────────────────

describe('full script lifecycle', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
    });
    afterEach(() => cleanup());

    it('create → set_state → read_step → advance × N → complete', async () => {
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH,
            title: 'Full Run',
            goal: 'Execute all steps.',
            steps: JSON.stringify(['Alpha', 'Beta']),
        });

        // Set scratchpad.
        await call(sandbox, 'script/set_state', {
            path: SCRIPT_PATH,
            scratchpad: 'Starting Alpha.',
        });

        // Read current step — should have scratchpad.
        const step1 = await call(sandbox, 'script/read_step', { path: SCRIPT_PATH });
        expect(step1['step_id']).toBe('S1');
        expect((step1['state'] as Record<string, unknown>)['scratchpad']).toBe('Starting Alpha.');

        // Advance S1.
        await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'Alpha done.' });

        // Advance S2 — should complete.
        const final = await call(sandbox, 'script/advance', { path: SCRIPT_PATH, summary: 'Beta done.' });
        expect(final['complete']).toBe(true);

        const content = readFile(root, SCRIPT_PATH);
        expect(content).toContain('Status: complete');
        expect(content).toContain('- [x] S1: Alpha');
        expect(content).toContain('- [x] S2: Beta');
    });

    it('fail × 3 triggers escalation, agent can still read_step', async () => {
        await call(sandbox, 'script/create', {
            path: SCRIPT_PATH,
            title: 'Blocked',
            goal: 'Try to do X.',
            steps: JSON.stringify(['Try X']),
        });

        for (let i = 1; i <= 3; i++) {
            const r = await call(sandbox, 'script/fail_step', { path: SCRIPT_PATH, reason: `fail ${i}` });
            if (i < 3) expect(r['escalate']).toBe(false);
            else expect(r['escalate']).toBe(true);
        }

        // Script is still readable — agent or new agent can orient.
        const status = await call(sandbox, 'script/status', { path: SCRIPT_PATH });
        expect(status['current']).toBe('S1');
        expect(status['attempts']).toBe(3);
    });
});
