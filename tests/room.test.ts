/**
 * Foundational tests for the Ivy chatroom core:
 * - isVisibleTo (visibility rules)
 * - RoomLog (persistence, ordering, filtered reads)
 * - Room (sender validation, DM target validation, routing)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isVisibleTo } from '../src/types.js';
import { RoomLog } from '../src/RoomLog.js';
import { Room } from '../src/Room.js';
import type { Message, Participant } from '../src/types.js';
import { createInMemoryDb } from './helpers/inMemoryDb.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeParticipant(handle: string, displayName?: string): Participant & { received: Message[] } {
    const received: Message[] = [];
    return {
        handle,
        displayName: displayName ?? handle,
        receive(msg: Message) { received.push(msg); },
        received,
    };
}

// ─── isVisibleTo ────────────────────────────────────────────────

describe('isVisibleTo', () => {
    const broadcast: Message = { id: '1', from: '@ivy', to: '*', text: 'hi', timestamp: 1 };
    const dm: Message = { id: '2', from: '@ivy', to: '@architect', text: 'secret', timestamp: 2 };

    it('broadcast is visible to everyone', () => {
        expect(isVisibleTo(broadcast, '@ivy')).toBe(true);
        expect(isVisibleTo(broadcast, '@nova')).toBe(true);
        expect(isVisibleTo(broadcast, '@architect')).toBe(true);
    });

    it('DM is visible to sender and recipient only', () => {
        expect(isVisibleTo(dm, '@ivy')).toBe(true);       // sender
        expect(isVisibleTo(dm, '@architect')).toBe(true);  // recipient
        expect(isVisibleTo(dm, '@nova')).toBe(false);      // third party
    });
});

// ─── RoomLog ────────────────────────────────────────────────────

describe('RoomLog', () => {
    let log: RoomLog;

    beforeEach(() => {
        log = new RoomLog(createInMemoryDb());
    });

    it('append persists and returns a well-formed message', () => {
        const msg = log.append('@ivy', '*', 'hello');
        expect(msg.id).toBeDefined();
        expect(msg.from).toBe('@ivy');
        expect(msg.to).toBe('*');
        expect(msg.text).toBe('hello');
        expect(typeof msg.timestamp).toBe('number');
        expect(log.count()).toBe(1);
    });

    it('getAll returns messages in insertion order', () => {
        log.append('@ivy', '*', 'first');
        log.append('@nova', '*', 'second');
        log.append('@architect', '*', 'third');
        const all = log.getAll();
        expect(all.map(m => m.text)).toEqual(['first', 'second', 'third']);
    });

    it('getVisibleTo returns broadcasts + own DMs', () => {
        log.append('@ivy', '*', 'public');
        log.append('@ivy', '@architect', 'whisper');
        log.append('@nova', '@ivy', 'to-ivy');
        log.append('@nova', '@architect', 'nova-to-arch');

        const ivySees = log.getVisibleTo('@ivy');
        expect(ivySees.map(m => m.text)).toEqual(['public', 'whisper', 'to-ivy']);
    });

    it('getPublic returns only broadcasts', () => {
        log.append('@ivy', '*', 'pub');
        log.append('@ivy', '@nova', 'priv');
        expect(log.getPublic().map(m => m.text)).toEqual(['pub']);
    });

    it('getPrivate returns only non-broadcast involving handle', () => {
        log.append('@ivy', '*', 'pub');
        log.append('@ivy', '@nova', 'dm-out');
        log.append('@architect', '@ivy', 'dm-in');
        log.append('@ivy', '@ivy', 'internal');
        const priv = log.getPrivate('@ivy');
        expect(priv.map(m => m.text)).toEqual(['dm-out', 'dm-in']);
    });

    it('getInternal returns only self-to-self notes', () => {
        log.append('@ivy', '@ivy', 'note-1');
        log.append('@ivy', '@nova', 'dm-out');
        log.append('@nova', '@nova', 'note-2');
        const internal = log.getInternal('@ivy');
        expect(internal.map(m => m.text)).toEqual(['note-1']);
    });

    it('respects limit parameter', () => {
        for (let i = 0; i < 10; i++) log.append('@ivy', '*', `msg-${i}`);
        expect(log.getAll(3)).toHaveLength(3);
        // Should return the *most recent* 3 in chronological order
        expect(log.getAll(3).map(m => m.text)).toEqual(['msg-7', 'msg-8', 'msg-9']);
    });

    it('same-timestamp writes are returned in insertion order', () => {
        // Force identical timestamps to verify insertion-order stability
        // (the real SQL uses rowid DESC as a tiebreaker; the in-memory mock
        // preserves array insertion order, so both behaviours agree here).
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        log.append('@ivy', '*', 'a');
        log.append('@nova', '*', 'b');
        log.append('@architect', '*', 'c');
        vi.restoreAllMocks();

        const all = log.getAll();
        expect(all.map(m => m.text)).toEqual(['a', 'b', 'c']);
    });
});

// ─── Room ───────────────────────────────────────────────────────

describe('Room', () => {
    let log: RoomLog;
    let room: Room;

    beforeEach(() => {
        log = new RoomLog(createInMemoryDb());
        room = new Room(log);
    });

    it('join prevents duplicate handles', () => {
        room.join(makeParticipant('@ivy'));
        expect(() => room.join(makeParticipant('@ivy'))).toThrow('already in room');
    });

    it('post rejects non-member sender', () => {
        expect(() => room.post('@ghost', 'hello')).toThrow('not a participant');
    });

    it('dm rejects non-member sender', () => {
        room.join(makeParticipant('@ivy'));
        expect(() => room.dm('@ghost', '@ivy', 'hi')).toThrow('not a participant');
    });

    it('post delivers to all other participants', () => {
        const ivy = makeParticipant('@ivy');
        const nova = makeParticipant('@nova');
        room.join(ivy);
        room.join(nova);

        room.post('@ivy', 'hello');
        // ivy should NOT receive her own message
        expect(ivy.received).toHaveLength(0);
        // nova should receive it
        expect(nova.received).toHaveLength(1);
        expect(nova.received[0].text).toBe('hello');
    });

    it('dm delivers only to recipient (not third parties)', () => {
        const ivy = makeParticipant('@ivy');
        const nova = makeParticipant('@nova');
        const arch = makeParticipant('@architect');
        room.join(ivy);
        room.join(nova);
        room.join(arch);

        room.dm('@ivy', '@architect', 'secret');
        expect(ivy.received).toHaveLength(0);        // sender doesn't get it
        expect(arch.received).toHaveLength(1);        // recipient gets it
        expect(nova.received).toHaveLength(0);        // third party doesn't
    });

    it('note stores internal self-message and does not notify others', () => {
        const ivy = makeParticipant('@ivy');
        const nova = makeParticipant('@nova');
        room.join(ivy);
        room.join(nova);

        room.note('@ivy', 'private thought');

        expect(ivy.received).toHaveLength(0);
        expect(nova.received).toHaveLength(0);
        expect(room.getInternal('@ivy').map(m => m.text)).toEqual(['private thought']);
        expect(room.getPrivate('@ivy').map(m => m.text)).not.toContain('private thought');
    });

    it('dm to unknown handle logs warning, notifies sender, and still persists', () => {
        const ivy = makeParticipant('@ivy');
        const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const roomWithLogger = new Room(log, mockLogger as any);
        roomWithLogger.join(ivy);

        const msg = roomWithLogger.dm('@ivy', '@ghost', 'lost message');
        expect(msg.to).toBe('@ghost');
        // 2 messages: the feedback note to the sender + the persisted DM
        expect(log.count()).toBe(2);
        // Sender receives an internal note about the failure
        const internals = roomWithLogger.getInternal('@ivy', 5);
        expect(internals.some(m => m.text.includes('@ghost'))).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('@ghost'),
            expect.any(Object),
        );
    });

    it('getParticipants lists joined members', () => {
        room.join(makeParticipant('@ivy', 'Ivy'));
        room.join(makeParticipant('@nova', 'Nova'));
        const list = room.getParticipants();
        expect(list).toEqual([
            { handle: '@ivy', displayName: 'Ivy' },
            { handle: '@nova', displayName: 'Nova' },
        ]);
    });

    it('leave removes a participant', () => {
        const ivy = makeParticipant('@ivy');
        room.join(ivy);
        expect(room.hasParticipant('@ivy')).toBe(true);
        room.leave('@ivy');
        expect(room.hasParticipant('@ivy')).toBe(false);
    });

    it('leave throws for non-existent handle', () => {
        expect(() => room.leave('@ghost')).toThrow('not in the room');
    });
});
