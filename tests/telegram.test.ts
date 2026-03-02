/**
 * Tests for TelegramParticipant — Telegram bridge.
 * - Outbound: receive() forwards room messages to notification:send
 * - Inbound: notification:receive events are posted to the room
 * - Slash commands: /pm, /who, unknown
 * - Lifecycle: start/stop idempotency
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramParticipant } from '../src/TelegramParticipant.js';
import { RoomLog } from '../src/RoomLog.js';
import { Room } from '../src/Room.js';
import type { Message } from '../src/types.js';
import { createInMemoryDb } from './helpers/inMemoryDb.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeEventBus() {
    const handlers = new Map<string, (payload: any) => void>();
    return {
        on: vi.fn((event: string, handler: (payload: any) => void) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }),
        emit: vi.fn().mockResolvedValue(undefined),
        trigger(event: string, payload: any) {
            handlers.get(event)?.(payload);
        },
    };
}

function makeRoom() {
    return new Room(new RoomLog(createInMemoryDb()));
}

function msg(from: string, text: string, to = '*'): Message {
    return { id: '1', from, to, text, timestamp: Date.now() };
}

// ─── Outbound (receive → notification:send) ──────────────────────

describe('TelegramParticipant outbound', () => {
    it('forwards a broadcast room message to Telegram', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );

        participant.receive(msg('@ivy', 'hello everyone'));

        expect(events.emit).toHaveBeenCalledOnce();
        const [event, payload] = events.emit.mock.calls[0];
        expect(event).toBe('notification:send');
        expect(payload.title).toBe('@ivy');
        expect(payload.message).toBe('hello everyone');
        expect(payload.markdown).toBe(true);
    });

    it('formats DM title as "sender → you"', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );

        participant.receive(msg('@ivy', 'private note', '@architect'));

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.title).toBe('@ivy → you');
        expect(payload.message).toBe('private note');
    });
});

// ─── Inbound (notification:receive → room.post) ──────────────────

describe('TelegramParticipant inbound', () => {
    let room: Room;
    let events: ReturnType<typeof makeEventBus>;
    let participant: TelegramParticipant;
    let ivy: { handle: string; displayName: string; receive: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        room = makeRoom();
        events = makeEventBus();
        participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(participant);
        room.join(ivy);
        participant.start();
    });

    it('posts a plain text notification to the room', () => {
        events.trigger('notification:receive', { text: 'hello agents' });

        expect(ivy.receive).toHaveBeenCalledOnce();
        const received = ivy.receive.mock.calls[0][0] as Message;
        expect(received.from).toBe('@architect');
        expect(received.text).toBe('hello agents');
        expect(received.to).toBe('*');
    });

    it('ignores empty text payloads', () => {
        events.trigger('notification:receive', { text: '   ' });
        events.trigger('notification:receive', { text: '' });
        events.trigger('notification:receive', {});

        expect(ivy.receive).not.toHaveBeenCalled();
    });
});

// ─── Slash commands ──────────────────────────────────────────────

describe('TelegramParticipant slash commands', () => {
    let room: Room;
    let events: ReturnType<typeof makeEventBus>;
    let participant: TelegramParticipant;

    beforeEach(() => {
        room = makeRoom();
        events = makeEventBus();
        participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        room.join(participant);
        participant.start();
    });

    it('/who lists participants', () => {
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        events.trigger('notification:receive', { kind: 'command', key: 'who', text: '/who' });

        expect(events.emit).toHaveBeenCalledOnce();
        const [event, payload] = events.emit.mock.calls[0];
        expect(event).toBe('notification:send');
        expect(payload.message).toContain('@architect');
        expect(payload.message).toContain('@nova');
    });

    it('/pm sends a DM to a known participant', () => {
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        events.trigger('notification:receive', {
            kind: 'command',
            key: 'pm',
            text: '/pm @nova hey there',
        });

        expect(nova.receive).toHaveBeenCalledOnce();
        const dm = nova.receive.mock.calls[0][0] as Message;
        expect(dm.from).toBe('@architect');
        expect(dm.to).toBe('@nova');
        expect(dm.text).toBe('hey there');
    });

    it('/pm shows usage when format is wrong', () => {
        events.trigger('notification:receive', {
            kind: 'command',
            key: 'pm',
            text: '/pm no-handle-here',
        });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('/pm @handle');
    });

    it('unknown command sends an error message to Telegram', () => {
        events.trigger('notification:receive', {
            kind: 'command',
            key: 'foo',
            text: '/foo',
        });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('/foo');
        expect(payload.message).toContain('not recognized');
    });
});

// ─── Lifecycle ───────────────────────────────────────────────────

describe('TelegramParticipant lifecycle', () => {
    it('start is idempotent — only subscribes once', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        room.join(participant);

        participant.start();
        participant.start();
        participant.start();

        expect(events.on).toHaveBeenCalledOnce();
    });

    it('stop unsubscribes from events', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(participant);
        room.join(ivy);

        participant.start();
        participant.stop();

        // Trigger after stop — should not reach the room
        events.trigger('notification:receive', { text: 'too late' });
        expect(ivy.receive).not.toHaveBeenCalled();
    });

    it('can be restarted after stop', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(participant);
        room.join(ivy);

        participant.start();
        participant.stop();
        participant.start();

        events.trigger('notification:receive', { text: 'back online' });
        expect(ivy.receive).toHaveBeenCalledOnce();
    });
});
