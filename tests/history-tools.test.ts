/**
 * Tests for HistoryToolPack (history/view and history/search).
 *
 * Uses an in-memory Room backed by a real RoomLog (SQLite :memory:) so all
 * room methods work exactly as in production. Privacy is verified by asserting
 * that callerHandle never sees another agent's private messages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createTestDatabase } from '@nucleic-se/gears/testing';
import { Room } from '../src/Room.js';
import { RoomLog } from '../src/RoomLog.js';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { HistoryToolPack } from '../src/packs/HistoryToolPack.js';

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

function makeRoom() {
    const db  = createTestDatabase();
    const log  = new RoomLog(db);
    const room = new Room(log);
    // Minimal stubs so room.post/dm/note don't throw on assertMember.
    const stub = (handle: string) => room.join({ handle, displayName: handle, receive: () => {} });
    stub('@ivy');
    stub('@nova');
    stub('@architect');
    stub('@sentinel');
    return room;
}

async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>, caller = '@ivy'): Promise<any> {
    const raw = await sandbox.execCall(tool, args, caller);
    const arrow = raw.indexOf(' → ');
    if (arrow === -1) throw new Error(`No arrow in result: ${raw}`);
    return JSON.parse(raw.slice(arrow + 3));
}

function makeSandbox(room: Room) {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-history-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new HistoryToolPack(room).createLayer());
    return { sandbox, cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }) };
}

// ─── history/view ────────────────────────────────────────────────

describe('history/view — public', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('returns public messages in chronological order', async () => {
        room.post('@ivy', 'Hello room');
        room.post('@nova', 'Hey ivy');
        const r = await call(sandbox, 'history/view', {});
        expect(r.messages).toHaveLength(2);
        expect(r.messages[0].text).toBe('Hello room');
        expect(r.messages[1].text).toBe('Hey ivy');
    });

    it('does not include `to` field for broadcast messages', async () => {
        room.post('@ivy', 'broadcast');
        const r = await call(sandbox, 'history/view', {});
        expect(r.messages[0].to).toBeUndefined();
    });

    it('respects limit', async () => {
        for (let i = 0; i < 10; i++) room.post('@ivy', `msg ${i}`);
        const r = await call(sandbox, 'history/view', { limit: 3 });
        expect(r.messages).toHaveLength(3);
        expect(r.has_more).toBe(true);
    });

    it('filters by from handle', async () => {
        room.post('@ivy', 'ivy says');
        room.post('@nova', 'nova says');
        const r = await call(sandbox, 'history/view', { from: '@nova' });
        expect(r.messages).toHaveLength(1);
        expect(r.messages[0].from).toBe('@nova');
    });

    it('paginates using before timestamp', async () => {
        room.post('@ivy', 'old message');
        const pivot = Date.now();
        // ensure new timestamp is after pivot
        await new Promise(r => setTimeout(r, 5));
        room.post('@ivy', 'new message');
        const r = await call(sandbox, 'history/view', { before: new Date(pivot + 1).toISOString() });
        // should only see old message
        expect(r.messages.every((m: any) => m.text === 'old message')).toBe(true);
    });

    it('does not expose DMs or internal notes', async () => {
        room.post('@ivy', 'public');
        room.dm('@ivy', '@nova', 'private');
        room.note('@ivy', 'self note');
        const r = await call(sandbox, 'history/view', { type: 'public' });
        expect(r.messages).toHaveLength(1);
        expect(r.messages[0].text).toBe('public');
    });
});

describe('history/view — private', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('returns DMs involving caller only', async () => {
        room.dm('@ivy',  '@nova',      'ivy to nova');
        room.dm('@nova', '@ivy',       'nova to ivy');
        room.dm('@nova', '@architect', 'nova to arch — should not appear');
        const r = await call(sandbox, 'history/view', { type: 'private' }, '@ivy');
        expect(r.messages).toHaveLength(2);
        const texts = r.messages.map((m: any) => m.text);
        expect(texts).toContain('ivy to nova');
        expect(texts).toContain('nova to ivy');
        expect(texts).not.toContain('nova to arch — should not appear');
    });

    it('includes `to` field on private messages', async () => {
        room.dm('@ivy', '@nova', 'secret');
        const r = await call(sandbox, 'history/view', { type: 'private' }, '@ivy');
        expect(r.messages[0].to).toBe('@nova');
    });

    it('nova cannot see ivy–architect DMs', async () => {
        room.dm('@ivy', '@architect', 'ivy–arch DM');
        const r = await call(sandbox, 'history/view', { type: 'private' }, '@nova');
        expect(r.messages).toHaveLength(0);
    });
});

describe('history/view — internal', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('returns only own internal notes', async () => {
        room.note('@ivy',  'ivy note');
        room.note('@nova', 'nova note');
        const r = await call(sandbox, 'history/view', { type: 'internal' }, '@ivy');
        expect(r.messages).toHaveLength(1);
        expect(r.messages[0].text).toBe('ivy note');
    });

    it('does not include `to` field for self-notes', async () => {
        room.note('@ivy', 'private thought');
        const r = await call(sandbox, 'history/view', { type: 'internal' }, '@ivy');
        expect(r.messages[0].to).toBeUndefined();
    });
});

// ─── history/search ──────────────────────────────────────────────

describe('history/search — public', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('finds matching public messages case-insensitively', async () => {
        room.post('@ivy', 'The Quick Brown Fox');
        room.post('@nova', 'something else entirely');
        const r = await call(sandbox, 'history/search', { query: 'quick brown' });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].text).toBe('The Quick Brown Fox');
    });

    it('returns empty matches when nothing found', async () => {
        room.post('@ivy', 'hello world');
        const r = await call(sandbox, 'history/search', { query: 'zzz' });
        expect(r.matches).toHaveLength(0);
        expect(r.truncated).toBe(false);
    });

    it('respects limit and sets truncated flag', async () => {
        for (let i = 0; i < 10; i++) room.post('@ivy', `match ${i}`);
        const r = await call(sandbox, 'history/search', { query: 'match', limit: 3 });
        expect(r.matches).toHaveLength(3);
        expect(r.truncated).toBe(true);
        expect(r.count).toBe(10);
    });

    it('filters by sender', async () => {
        room.post('@ivy',  'ivy match');
        room.post('@nova', 'nova match');
        const r = await call(sandbox, 'history/search', { query: 'match', from: '@ivy' });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].from).toBe('@ivy');
    });

    it('does not expose DMs in public search', async () => {
        room.dm('@ivy', '@nova', 'secret match');
        room.post('@ivy', 'public match');
        const r = await call(sandbox, 'history/search', { query: 'match', type: 'public' });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].text).toBe('public match');
    });
});

describe('history/search — private', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('finds DMs involving caller', async () => {
        room.dm('@ivy',  '@nova', 'ivy sent this match');
        room.dm('@nova', '@ivy',  'nova sent this match');
        room.dm('@nova', '@architect', 'not ivy match');
        const r = await call(sandbox, 'history/search', { query: 'match', type: 'private' }, '@ivy');
        const texts = r.matches.map((m: any) => m.text);
        expect(texts).toContain('ivy sent this match');
        expect(texts).toContain('nova sent this match');
        expect(texts).not.toContain('not ivy match');
    });
});

describe('history/search — all', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('includes public + caller DMs but not internal notes', async () => {
        room.post('@ivy',  'public match');
        room.dm('@ivy', '@nova', 'dm match');
        room.note('@ivy', 'internal match');
        const r = await call(sandbox, 'history/search', { query: 'match', type: 'all' }, '@ivy');
        const texts = r.matches.map((m: any) => m.text);
        expect(texts).toContain('public match');
        expect(texts).toContain('dm match');
        expect(texts).not.toContain('internal match');
    });

    it('does not expose another agent\'s DMs', async () => {
        room.dm('@nova', '@architect', 'secret nova–arch match');
        room.post('@ivy', 'public match');
        const r = await call(sandbox, 'history/search', { query: 'match', type: 'all' }, '@ivy');
        const texts = r.matches.map((m: any) => m.text);
        expect(texts).not.toContain('secret nova–arch match');
    });
});

// ─── discovery ───────────────────────────────────────────────────

describe('discovery', () => {
    let room: Room;
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        room = makeRoom();
        ({ sandbox, cleanup } = makeSandbox(room));
    });
    afterEach(() => cleanup());

    it('tools appear in /tools/history listing', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/history' });
        expect(result).toContain('f  view.json');
        expect(result).toContain('f  search.json');
    });
});
