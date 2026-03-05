/**
 * Tests for TelegramParticipant — Telegram bridge.
 * - Outbound: receive() forwards room messages to notification:send
 * - Inbound: notification:receive events are posted to the room
 * - Slash commands: /dm, /who, unknown
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

async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
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

    it('/dm sends a DM to a known participant', () => {
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        events.trigger('notification:receive', {
            kind: 'command',
            key: 'dm',
            text: '/dm @nova hey there',
        });

        expect(nova.receive).toHaveBeenCalledOnce();
        const dm = nova.receive.mock.calls[0][0] as Message;
        expect(dm.from).toBe('@architect');
        expect(dm.to).toBe('@nova');
        expect(dm.text).toBe('hey there');
    });

    it('/dm accepts handles with hyphen/underscore', () => {
        const ops = { handle: '@ops-bot_1', displayName: 'Ops', receive: vi.fn() };
        room.join(ops);

        events.trigger('notification:receive', {
            kind: 'command',
            key: 'dm',
            text: '/dm @ops-bot_1 hello',
        });

        expect(ops.receive).toHaveBeenCalledOnce();
        const dm = ops.receive.mock.calls[0][0] as Message;
        expect(dm.to).toBe('@ops-bot_1');
        expect(dm.text).toBe('hello');
    });

    it('/dm shows usage when format is wrong', () => {
        events.trigger('notification:receive', {
            kind: 'command',
            key: 'dm',
            text: '/dm no-handle-here',
        });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('/dm @handle');
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
        // Available commands are listed dynamically
        expect(payload.message).toContain('/dm');
        expect(payload.message).toContain('/mute');
        expect(payload.message).toContain('/filters');
    });
});

// ─── Inspector commands ───────────────────────────────────────────

describe('TelegramParticipant inspector commands', () => {
    it('/schedules lists reminders from schedule inspector', async () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant({
            handle: '@architect',
            displayName: 'Architect',
            scheduleInspector: {
                list: vi.fn().mockResolvedValue([
                    { owner: '@ivy', id: 'daily', type: 'cron', schedule: '0 9 * * *', message: 'daily check', persisted: true },
                ]),
            },
        }, room, events as any);
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'schedules', text: '/schedules' });
        await flush();

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.markdown).toBe(false);
        expect(payload.message).toContain('1. @ivy | cron | daily');
        expect(payload.message).toContain('when: 0 9 * * *');
        expect(payload.message).toContain('note: daily check');
    });

    it('/tools lists available sandbox tools', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const sandbox = {
            listTools: vi.fn().mockReturnValue([
                { group: 'text', name: 'read', description: 'Read file' },
                { group: 'schedule', name: 'list', description: 'List reminders' },
            ]),
        };
        const participant = new TelegramParticipant({
            handle: '@architect',
            displayName: 'Architect',
            sandbox: sandbox as any,
        }, room, events as any);
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'tools', text: '/tools' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('text/read');
        expect(payload.message).toContain('schedule/list');
    });

    it('/ls reads sandbox directory listing', async () => {
        const events = makeEventBus();
        const room = makeRoom();
        const sandbox = {
            execFs: vi.fn().mockResolvedValue('fs:ls /home →\nf  notes.md'),
        };
        const participant = new TelegramParticipant({
            handle: '@architect',
            displayName: 'Architect',
            sandbox: sandbox as any,
        }, room, events as any);
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'ls', text: '/ls /home' });
        await flush();

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('notes.md');
    });

    it('/cat uses text/read tool and shows numbered content', async () => {
        const events = makeEventBus();
        const room = makeRoom();
        const sandbox = {
            execCall: vi.fn().mockResolvedValue('call:text/read → {"content":"1: hello","from_line":1,"to_line":1,"total_lines":1,"hash":"abc"}'),
        };
        const participant = new TelegramParticipant({
            handle: '@architect',
            displayName: 'Architect',
            sandbox: sandbox as any,
        }, room, events as any);
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'cat', text: '/cat /home/notes.md' });
        await flush();

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('1: hello');
    });

    it('/md reads markdown by absolute path', async () => {
        const events = makeEventBus();
        const room = makeRoom();
        const sandbox = {
            execFs: vi.fn().mockResolvedValue('fs:read /home/ivy/notes.md →\n# Notes\n\nHello'),
        };
        const participant = new TelegramParticipant({
            handle: '@architect',
            displayName: 'Architect',
            sandbox: sandbox as any,
        }, room, events as any);
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'md', text: '/md /home/ivy/notes.md' });
        await flush();

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.title).toContain('/home/ivy/notes.md');
        expect(payload.message).toContain('# Notes');
        expect(payload.markdown).toBe(true);
    });

    it('/md fuzzy query resolves and reads best markdown match', async () => {
        const events = makeEventBus();
        const room = makeRoom();
        const sandbox = {
            execCall: vi.fn()
                .mockResolvedValueOnce('call:text/find → {"results":[{"path":"/home/ivy/tasks/research-notes.md","type":"f"},{"path":"/home/ivy/tasks/plan.md","type":"f"}],"truncated":false}')
                .mockResolvedValueOnce('call:text/find → {"results":[{"path":"/data/projects/research-log.md","type":"f"}],"truncated":false}'),
            execFs: vi.fn().mockResolvedValue('fs:read /home/ivy/tasks/research-notes.md →\n# Picked\n\nok'),
        };
        const participant = new TelegramParticipant({
            handle: '@architect',
            displayName: 'Architect',
            sandbox: sandbox as any,
        }, room, events as any);
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'md', text: '/md research-notes' });
        await flush();

        expect(sandbox.execFs).toHaveBeenLastCalledWith({ type: 'fs', op: 'read', path: '/home/ivy/tasks/research-notes.md' }, '@architect');
        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('# Picked');
    });

    it('falls back to plain text when markdown send fails', async () => {
        const events = makeEventBus();
        events.emit = vi.fn()
            .mockRejectedValueOnce(new Error('Bad Request: markdown parse error'))
            .mockResolvedValueOnce(undefined);
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        room.join(participant);

        participant.receive(msg('@ivy', '**bad _markdown_**'));
        await flush();
        await flush();

        expect(events.emit).toHaveBeenCalledTimes(2);
        expect(events.emit.mock.calls[0][1].markdown).toBe(true);
        expect(events.emit.mock.calls[1][1].markdown).toBe(false);
    });
});

// ─── Filter commands ─────────────────────────────────────────────

describe('TelegramParticipant filter commands', () => {
    let room: Room;
    let events: ReturnType<typeof makeEventBus>;
    let participant: TelegramParticipant;
    let nova: { handle: string; displayName: string; receive: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        room = makeRoom();
        events = makeEventBus();
        participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);
        participant.start();
    });

    // ── /mute ───────────────────────────────────────────────────

    it('/mute @handle sends confirmation to Telegram', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @nova' });

        const [event, payload] = events.emit.mock.calls[0];
        expect(event).toBe('notification:send');
        expect(payload.message).toContain('@nova');
        expect(payload.message).toContain('muted');
    });

    it('/mute @handle blocks subsequent room messages from that handle', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @nova' });
        events.emit.mockClear();

        participant.receive(msg('@nova', 'hello everyone'));

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('/mute with no handle shows mute state', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('Focus mode:');
        expect(payload.message).toContain('Muted:');
    });

    it('/mute does not block messages from other handles', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @nova' });
        events.emit.mockClear();

        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(ivy);
        participant.receive(msg('@ivy', 'hello from ivy'));

        expect(events.emit).toHaveBeenCalledOnce();
    });

    // ── /mute off ───────────────────────────────────────────────

    it('/mute off @handle restores a muted handle', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @nova' });
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute off @nova' });
        events.emit.mockClear();

        participant.receive(msg('@nova', 'back again'));

        expect(events.emit).toHaveBeenCalledOnce();
    });

    it('/mute off with no handle clears all mutes', () => {
        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(ivy);

        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @nova' });
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @ivy' });
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute off' });
        events.emit.mockClear();

        participant.receive(msg('@nova', 'nova back'));
        participant.receive(msg('@ivy', 'ivy back'));

        expect(events.emit).toHaveBeenCalledTimes(2);
    });

    it('/mute off with no arg sends all-clear confirmation', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute off' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('All mutes cleared');
    });

    // ── /focus ──────────────────────────────────────────────────

    it('/focus sends confirmation to Telegram', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('Focus mode ON');
    });

    it('/focus blocks broadcasts that do not mention self', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus' });
        events.emit.mockClear();

        participant.receive(msg('@nova', '@ivy check this out', '*'));

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('/focus passes broadcasts that mention self', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus' });
        events.emit.mockClear();

        participant.receive(msg('@nova', '@architect look at this', '*'));

        expect(events.emit).toHaveBeenCalledOnce();
    });

    it('/focus passes DMs addressed to self', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus' });
        events.emit.mockClear();

        participant.receive(msg('@nova', 'private message', '@architect'));

        expect(events.emit).toHaveBeenCalledOnce();
    });

    // ── /focus off ──────────────────────────────────────────────

    it('/focus off restores all traffic after focus', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus' });
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus off' });
        events.emit.mockClear();

        participant.receive(msg('@nova', 'unrelated message', '*'));

        expect(events.emit).toHaveBeenCalledOnce();
    });

    it('/focus off sends confirmation to Telegram', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus off' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('Focus mode OFF');
    });

    // ── /filters ────────────────────────────────────────────────

    it('/filters shows focus state and mute list', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'mute', text: '/mute @nova' });
        events.trigger('notification:receive', { kind: 'command', key: 'focus', text: '/focus on' });
        events.emit.mockClear();

        events.trigger('notification:receive', { kind: 'command', key: 'filters', text: '/filters' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('Focus mode: ON');
        expect(payload.message).toContain('@nova');
    });

    it('/filters shows default state when no filters set', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'filters', text: '/filters' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('Focus mode: OFF');
        expect(payload.message).toContain('Muted: none');
    });
});

// ─── /help ───────────────────────────────────────────────────────

describe('TelegramParticipant /help', () => {
    it('lists all commands with descriptions', () => {
        const events = makeEventBus();
        const room = makeRoom();
        const participant = new TelegramParticipant(
            { handle: '@architect', displayName: 'Architect' },
            room, events as any,
        );
        room.join(participant);
        participant.start();

        events.trigger('notification:receive', { kind: 'command', key: 'help', text: '/help' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('/dm');
        expect(payload.message).toContain('/who');
        expect(payload.message).toContain('/mute');
        expect(payload.message).toContain('/wiretap');
        expect(payload.message).toContain('/help');
    });
});

// ─── /wiretap ────────────────────────────────────────────────────

describe('TelegramParticipant /wiretap', () => {
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

    it('sends ON confirmation when activated', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('ON');
    });

    it('sends OFF confirmation when deactivated', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        events.emit.mockClear();
        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.message).toContain('OFF');
    });

    it('delivers agent-to-agent DMs via wiretap', () => {
        const ivy  = { handle: '@ivy',  displayName: 'Ivy',  receive: vi.fn() };
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(ivy);
        room.join(nova);

        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        events.emit.mockClear();

        room.dm('@ivy', '@nova', 'secret handoff');

        expect(events.emit).toHaveBeenCalledOnce();
        const [, payload] = events.emit.mock.calls[0];
        expect(payload.title).toContain('@ivy');
        expect(payload.title).toContain('@nova');
        expect(payload.title).toContain('[DM]');
        expect(payload.message).toBe('secret handoff');
    });

    it('suppresses self-notes in wiretap mode', () => {
        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(ivy);

        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        events.emit.mockClear();

        room.note('@ivy', 'internal scratch');

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('formats DMs to self as "sender → you" in wiretap mode', () => {
        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(ivy);

        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        events.emit.mockClear();

        room.dm('@ivy', '@architect', 'report for you');

        const [, payload] = events.emit.mock.calls[0];
        expect(payload.title).toBe('@ivy → you');
    });

    it('does not echo own messages in wiretap mode', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        events.emit.mockClear();

        room.post('@architect', 'my own message');

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not duplicate messages from others in wiretap mode', () => {
        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        events.emit.mockClear();

        const ivy = { handle: '@ivy', displayName: 'Ivy', receive: vi.fn() };
        room.join(ivy);

        room.post('@ivy', 'hello everyone');

        // wiretap subscriber fires; receive() bails early — exactly one delivery
        expect(events.emit).toHaveBeenCalledOnce();
    });

    it('stops wiretap subscription when stop() is called', () => {
        const ivy  = { handle: '@ivy',  displayName: 'Ivy',  receive: vi.fn() };
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(ivy);
        room.join(nova);

        events.trigger('notification:receive', { kind: 'command', key: 'wiretap', text: '/wiretap' });
        participant.stop();
        events.emit.mockClear();

        room.dm('@ivy', '@nova', 'should not arrive');

        expect(events.emit).not.toHaveBeenCalled();
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
