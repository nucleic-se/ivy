/**
 * Tests for ScheduleToolPack (schedule/set, schedule/list, schedule/cancel).
 *
 * IScheduler is a vi.fn() mock — no real cron engine involved.
 * IStore is a MemoryStore — real in-memory implementation for persistence tests.
 * setTimeout behaviour is controlled with vi.useFakeTimers().
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IScheduler, IStore } from 'gears';
import { MemoryStore } from 'gears/testing';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { ScheduleToolPack } from '../src/packs/ScheduleToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-schedule-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    return { sandbox, cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }) };
}

function makeScheduler(): IScheduler {
    return {
        schedule: vi.fn(),
        unschedule: vi.fn(),
        stopAll: vi.fn(),
    };
}

/** Call a tool via sandbox.execCall and parse the JSON result. */
async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>, caller = '@ivy'): Promise<any> {
    const raw = await sandbox.execCall(tool, args, caller);
    const arrow = raw.indexOf(' → ');
    if (arrow === -1) throw new Error(`No arrow in result: ${raw}`);
    return JSON.parse(raw.slice(arrow + 3));
}

// ─── Setup helpers ───────────────────────────────────────────────

interface Fixtures {
    sandbox: Sandbox;
    pack: ScheduleToolPack;
    scheduler: IScheduler;
    store: IStore;
    fired: string[];
    cleanup: () => void;
}

function makeFixtures(options: { scheduler?: IScheduler | null; store?: IStore | null } = {}): Fixtures {
    const { sandbox, cleanup } = tempSandbox();
    const scheduler = options.scheduler !== undefined ? options.scheduler : makeScheduler();
    const store = options.store !== undefined ? options.store : new MemoryStore();
    const fired: string[] = [];

    const pack = new ScheduleToolPack();
    pack.registerAgent('@ivy', { scheduler, store });
    pack.setObserve('@ivy', text => fired.push(text));
    sandbox.mount(pack.createLayer());

    return { sandbox, pack, scheduler: scheduler!, store: store!, fired, cleanup };
}

// ─── Discovery ───────────────────────────────────────────────────

describe('schedule tool discovery', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        const f = makeFixtures();
        sandbox = f.sandbox;
        cleanup = f.cleanup;
    });
    afterEach(() => cleanup());

    it('appears in /tools listing', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools' });
        expect(result).toContain('d  schedule');
    });

    it('lists 3 tools under /tools/schedule', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/schedule' });
        expect(result).toContain('f  set.json');
        expect(result).toContain('f  list.json');
        expect(result).toContain('f  cancel.json');
    });

    it('manifest includes call and parameters', async () => {
        const raw = await sandbox.execFs({ type: 'fs', op: 'read', path: '/tools/schedule/set.json' });
        const json = JSON.parse(raw.split('\n').slice(1).join('\n'));
        expect(json.call).toBe('schedule/set');
        expect(json.parameters).toBeDefined();
    });
});

// ─── schedule/set — cron ─────────────────────────────────────────

describe('schedule/set — cron', () => {
    let fixtures: Fixtures;

    beforeEach(() => { fixtures = makeFixtures(); });
    afterEach(() => fixtures.cleanup());

    it('schedules a cron reminder and persists it', async () => {
        const { sandbox, scheduler, store } = fixtures;
        const r = await call(sandbox, 'schedule/set', {
            id: 'daily', message: 'Time to check in!', type: 'cron', schedule: '0 9 * * *',
        });
        expect(r.ok).toBe(true);
        expect(r.type).toBe('cron');
        expect(r.persisted).toBe(true);
        expect(scheduler.schedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function), 'ivy:schedule:ivy:daily');
        const stored = await store.namespace('ivy:schedule:ivy:cron').scan();
        expect(stored['daily']).toBeDefined();
    });

    it('fires the observe callback when the cron task executes', async () => {
        const { sandbox, scheduler, fired } = fixtures;
        await call(sandbox, 'schedule/set', {
            id: 'test', message: 'hello world', type: 'cron', schedule: '0 9 * * *',
        });
        // Extract the task function passed to schedule() and invoke it.
        const task = (scheduler.schedule as any).mock.calls[0][1] as () => void;
        task();
        expect(fired).toContain('[reminder:test] hello world');
    });

    it('replaces existing cron with same id', async () => {
        const { sandbox, scheduler } = fixtures;
        await call(sandbox, 'schedule/set', {
            id: 'daily', message: 'First', type: 'cron', schedule: '0 8 * * *',
        });
        await call(sandbox, 'schedule/set', {
            id: 'daily', message: 'Second', type: 'cron', schedule: '0 9 * * *',
        });
        expect(scheduler.unschedule).toHaveBeenCalledWith('ivy:schedule:ivy:daily');
        expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid cron expression', async () => {
        const { sandbox } = fixtures;
        const r = await call(sandbox, 'schedule/set', {
            id: 'bad', message: 'test', type: 'cron', schedule: 'not-a-cron',
        });
        expect(r.error).toMatch(/Invalid cron/);
    });

    it('returns error when IScheduler is unavailable', async () => {
        const { sandbox } = makeFixtures({ scheduler: null });
        const r = await call(sandbox, 'schedule/set', {
            id: 'x', message: 'test', type: 'cron', schedule: '0 9 * * *',
        });
        expect(r.error).toMatch(/IScheduler unavailable/);
    });

    it('is ephemeral when IStore is unavailable', async () => {
        const { sandbox } = makeFixtures({ store: null });
        const r = await call(sandbox, 'schedule/set', {
            id: 'x', message: 'test', type: 'cron', schedule: '0 9 * * *',
        });
        expect(r.ok).toBe(true);
        expect(r.persisted).toBe(false);
        expect(r.note).toMatch(/Ephemeral/);
    });
});

// ─── schedule/set — once ─────────────────────────────────────────

describe('schedule/set — once', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { vi.useRealTimers(); });

    it('schedules a one-shot reminder with setTimeout', async () => {
        const { sandbox, fired, cleanup } = makeFixtures();
        try {
            const future = new Date(Date.now() + 60_000).toISOString();
            const r = await call(sandbox, 'schedule/set', {
                id: 'soon', message: 'Meeting now!', type: 'once', schedule: future,
            });
            expect(r.ok).toBe(true);
            expect(r.type).toBe('once');
            expect(fired).toHaveLength(0);

            vi.advanceTimersByTime(60_001);
            await vi.runAllTimersAsync();
            expect(fired).toContain('[reminder:soon] Meeting now!');
        } finally { cleanup(); }
    });

    it('persists one-shot in IStore', async () => {
        const store = new MemoryStore();
        const { sandbox, cleanup } = makeFixtures({ store });
        try {
            const future = new Date(Date.now() + 3_600_000).toISOString();
            const r = await call(sandbox, 'schedule/set', {
                id: 'later', message: 'Check back', type: 'once', schedule: future,
            });
            expect(r.persisted).toBe(true);
            const stored = await store.namespace('ivy:schedule:ivy:once').get<any>('later');
            expect(stored).toBeDefined();
            expect(stored.message).toBe('Check back');
        } finally { cleanup(); }
    });

    it('rejects past datetime', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            const past = new Date(Date.now() - 60_000).toISOString();
            const r = await call(sandbox, 'schedule/set', {
                id: 'oops', message: 'Too late', type: 'once', schedule: past,
            });
            expect(r.error).toMatch(/past/);
        } finally { cleanup(); }
    });

    it('rejects invalid datetime', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            const r = await call(sandbox, 'schedule/set', {
                id: 'bad', message: 'nope', type: 'once', schedule: 'not-a-date',
            });
            expect(r.error).toMatch(/Invalid datetime/);
        } finally { cleanup(); }
    });

    it('replaces existing once with same id', async () => {
        const { sandbox, fired, cleanup } = makeFixtures({ store: null });
        try {
            const future1 = new Date(Date.now() + 10_000).toISOString();
            await call(sandbox, 'schedule/set', {
                id: 'x', message: 'First', type: 'once', schedule: future1,
            });
            const future2 = new Date(Date.now() + 5_000).toISOString();
            await call(sandbox, 'schedule/set', {
                id: 'x', message: 'Second', type: 'once', schedule: future2,
            });
            vi.advanceTimersByTime(10_001);
            await vi.runAllTimersAsync();
            // Only one fire — the second (shorter) timer wins.
            expect(fired.filter(f => f.includes('[reminder:x]'))).toHaveLength(1);
            expect(fired[0]).toContain('Second');
        } finally { cleanup(); }
    });
});

// ─── schedule/list ───────────────────────────────────────────────

describe('schedule/list', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { vi.useRealTimers(); });

    it('returns empty list when no reminders set', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            const r = await call(sandbox, 'schedule/list', {});
            expect(r.count).toBe(0);
            expect(r.reminders).toHaveLength(0);
        } finally { cleanup(); }
    });

    it('lists cron reminders from IStore', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            await call(sandbox, 'schedule/set', {
                id: 'daily', message: 'Check in', type: 'cron', schedule: '0 9 * * *',
            });
            const r = await call(sandbox, 'schedule/list', {});
            expect(r.count).toBe(1);
            expect(r.reminders[0].type).toBe('cron');
            expect(r.reminders[0].id).toBe('daily');
        } finally { cleanup(); }
    });

    it('lists pending one-shot reminders', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            const future = new Date(Date.now() + 3_600_000).toISOString();
            await call(sandbox, 'schedule/set', {
                id: 'soon', message: 'Stand-up', type: 'once', schedule: future,
            });
            const r = await call(sandbox, 'schedule/list', {});
            const once = r.reminders.find((x: any) => x.type === 'once');
            expect(once).toBeDefined();
            expect(once.id).toBe('soon');
        } finally { cleanup(); }
    });

    it('does not list a one-shot that already fired', async () => {
        const { sandbox, cleanup } = makeFixtures({ store: null });
        try {
            const future = new Date(Date.now() + 100).toISOString();
            await call(sandbox, 'schedule/set', {
                id: 'quick', message: 'Done soon', type: 'once', schedule: future,
            });
            vi.advanceTimersByTime(200);
            await vi.runAllTimersAsync();
            const r = await call(sandbox, 'schedule/list', {});
            expect(r.reminders.find((x: any) => x.id === 'quick')).toBeUndefined();
        } finally { cleanup(); }
    });
});

// ─── schedule/cancel ─────────────────────────────────────────────

describe('schedule/cancel', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { vi.useRealTimers(); });

    it('cancels a cron reminder and removes from IStore', async () => {
        const { sandbox, store, cleanup } = makeFixtures();
        try {
            await call(sandbox, 'schedule/set', {
                id: 'daily', message: 'Check in', type: 'cron', schedule: '0 9 * * *',
            });
            const r = await call(sandbox, 'schedule/cancel', { id: 'daily' });
            expect(r.ok).toBe(true);
            const stored = await store.namespace('ivy:schedule:ivy:cron').get('daily');
            expect(stored).toBeNull();
        } finally { cleanup(); }
    });

    it('cancels a pending one-shot (timer cleared, no fire)', async () => {
        const { sandbox, fired, cleanup } = makeFixtures({ store: null });
        try {
            const future = new Date(Date.now() + 10_000).toISOString();
            await call(sandbox, 'schedule/set', {
                id: 'x', message: 'Should not fire', type: 'once', schedule: future,
            });
            const r = await call(sandbox, 'schedule/cancel', { id: 'x' });
            expect(r.ok).toBe(true);
            vi.advanceTimersByTime(20_000);
            await vi.runAllTimersAsync();
            expect(fired).toHaveLength(0);
        } finally { cleanup(); }
    });

    it('returns error for unknown id', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            const r = await call(sandbox, 'schedule/cancel', { id: 'nonexistent' });
            expect(r.error).toMatch(/No reminder found/);
        } finally { cleanup(); }
    });

    it('requires id', async () => {
        const { sandbox, cleanup } = makeFixtures();
        try {
            const r = await call(sandbox, 'schedule/cancel', { id: '' });
            expect(r.error).toMatch(/id is required/);
        } finally { cleanup(); }
    });
});

// ─── Per-agent isolation ─────────────────────────────────────────

describe('per-agent isolation', () => {
    it('routes to correct agent by callerHandle', async () => {
        const { sandbox, cleanup } = tempSandbox();
        try {
            const firedIvy: string[] = [];
            const firedNova: string[] = [];

            const pack = new ScheduleToolPack();
            pack.registerAgent('@ivy',  { scheduler: makeScheduler(), store: new MemoryStore() });
            pack.registerAgent('@nova', { scheduler: makeScheduler(), store: new MemoryStore() });
            pack.setObserve('@ivy',  t => firedIvy.push(t));
            pack.setObserve('@nova', t => firedNova.push(t));
            sandbox.mount(pack.createLayer());

            // Set cron for ivy only
            const ivyRes = await call(sandbox, 'schedule/set', {
                id: 'ping', message: 'ivy-ping', type: 'cron', schedule: '* * * * *',
            }, '@ivy');
            expect(ivyRes.ok).toBe(true);

            // Nova's list should be empty
            const novaList = await call(sandbox, 'schedule/list', {}, '@nova');
            expect(novaList.count).toBe(0);

            // Ivy's list should have one entry
            const ivyList = await call(sandbox, 'schedule/list', {}, '@ivy');
            expect(ivyList.count).toBe(1);
        } finally { cleanup(); }
    });

    it('returns error for unregistered caller', async () => {
        const { sandbox, cleanup } = tempSandbox();
        try {
            const pack = new ScheduleToolPack();
            pack.registerAgent('@ivy', {});
            sandbox.mount(pack.createLayer());

            const r = await call(sandbox, 'schedule/list', {}, '@ghost');
            expect(r.error).toMatch(/not configured/);
        } finally { cleanup(); }
    });
});

// ─── Boot — restore persisted reminders ──────────────────────────

describe('boot — restore persisted state', () => {
    it('restores cron reminders from IStore on boot', async () => {
        const store = new MemoryStore();
        const { sandbox, cleanup } = tempSandbox();
        try {
            // Simulate a previous session: write directly to the store.
            await store.namespace('ivy:schedule:ivy:cron').set('morning', {
                id: 'morning', message: 'Good morning!', cron: '0 8 * * *', createdAt: Date.now(),
            });

            const scheduler = makeScheduler();
            const pack = new ScheduleToolPack();
            pack.registerAgent('@ivy', { scheduler, store });
            pack.setObserve('@ivy', () => {});
            sandbox.mount(pack.createLayer());

            await pack.boot();

            // IScheduler.schedule() should have been called to re-arm the cron.
            expect(scheduler.schedule).toHaveBeenCalledWith(
                '0 8 * * *', expect.any(Function), 'ivy:schedule:ivy:morning',
            );
        } finally { cleanup(); }
    });

    it('fires past-due one-shot reminders immediately on boot', async () => {
        const store = new MemoryStore();
        const { sandbox, cleanup } = tempSandbox();
        const fired: string[] = [];
        try {
            // Simulate a past-due one-shot.
            await store.namespace('ivy:schedule:ivy:once').set('overdue', {
                id: 'overdue', message: 'Was due ages ago', firesAt: Date.now() - 5_000, createdAt: Date.now() - 10_000,
            });

            const pack = new ScheduleToolPack();
            pack.registerAgent('@ivy', { store });
            pack.setObserve('@ivy', t => fired.push(t));
            sandbox.mount(pack.createLayer());

            await pack.boot();
            expect(fired).toContain('[reminder:overdue] Was due ages ago');
        } finally { cleanup(); }
    });
});
