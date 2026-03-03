/**
 * Tests for the Agent / AgentParticipant split:
 * - LLMAgent.think() in isolation (no Room)
 * - AgentParticipant adapter (queue, routing, context assembly, wake modes, heartbeat)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMAgent } from '../src/LLMAgent.js';
import { AgentParticipant } from '../src/AgentParticipant.js';
import { RoomLog } from '../src/RoomLog.js';
import { Room } from '../src/Room.js';
import type { Agent, AgentAction, AgentContext, Message } from '../src/types.js';
import { createTestDatabase, MemoryStore } from 'gears/testing';

// ─── Helpers ────────────────────────────────────────────────────

function mockLLM(result: Record<string, unknown>) {
    return { process: vi.fn().mockResolvedValue(result) } as any;
}

function msg(from: string, text: string, to = '*', id = '1', timestamp = Date.now()): Message {
    return { id, from, to, text, timestamp };
}

function baseContext(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
        publicMessages: [],
        privateMessages: [],
        internalMessages: [],
        stimuli: [],
        isMentioned: false,
        dmSenders: [],
        wakeMode: 'all',
        heartbeatMs: null,
        publicContextWindow: 25,
        privateContextWindow: 20,
        internalContextWindow: 15,
        ...overrides,
    };
}

// ─── LLMAgent (isolated cognition) ─────────────────────────────

describe('LLMAgent', () => {
    it('returns empty actions when LLM responds with {}', async () => {
        const llm = mockLLM({});
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext({
            stimuli: [msg('@nova', 'hello')],
        }));
        expect(result).toEqual([]);
    });

    it('returns speak action when LLM provides speak field', async () => {
        const llm = mockLLM({ speak: 'Hi there!' });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext({
            stimuli: [msg('@nova', 'hello @ivy')],
            isMentioned: true,
        }));
        expect(result).toEqual([{ type: 'speak', text: 'Hi there!' }]);
    });

    it('returns dm action when LLM provides dm field', async () => {
        const llm = mockLLM({ dm: { to: '@nova', text: 'secret' } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext({
            privateMessages: [msg('@nova', 'psst', '@ivy')],
            stimuli: [msg('@nova', 'psst', '@ivy')],
            dmSenders: ['@nova'],
        }));
        expect(result).toEqual([{ type: 'dm', to: '@nova', text: 'secret' }]);
    });

    it('returns note action when LLM provides note field', async () => {
        const llm = mockLLM({ note: 'Remember this.' });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext({
            stimuli: [msg('@nova', 'hello')],
        }));
        expect(result).toEqual([{ type: 'note', text: 'Remember this.' }]);
    });

    it('returns configure action when LLM provides configure field', async () => {
        const llm = mockLLM({ configure: { wakeOn: 'mentions', heartbeatMs: 5000 } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext());
        expect(result).toEqual([{ type: 'configure', wakeOn: 'mentions', heartbeatMs: 5000 }]);
    });

    it('returns multiple actions when LLM provides multiple fields', async () => {
        const llm = mockLLM({ speak: 'Hello!', note: 'Said hello.' });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext());
        expect(result).toContainEqual({ type: 'speak', text: 'Hello!' });
        expect(result).toContainEqual({ type: 'note', text: 'Said hello.' });
    });

    it('includes mention hint in prompt when isMentioned', async () => {
        const llm = mockLLM({});
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await agent.think(baseContext({
            stimuli: [msg('@nova', 'hey @ivy')],
            isMentioned: true,
        }));

        const call = llm.process.mock.calls[0][0];
        expect(call.text).toContain('You were mentioned');
    });

    it('includes DM hint in prompt when dmSenders is non-empty', async () => {
        const llm = mockLLM({});
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await agent.think(baseContext({
            stimuli: [msg('@nova', 'private', '@ivy')],
            dmSenders: ['@nova'],
        }));

        const call = llm.process.mock.calls[0][0];
        expect(call.text).toContain('private message');
        expect(call.text).toContain('@nova');
    });

    it('includes core prompt sections from internal prompt pack', async () => {
        const llm = mockLLM({});
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await agent.think(baseContext({
            publicMessages: [msg('@nova', 'hello')],
            privateMessages: [msg('@nova', 'dm', '@ivy')],
            internalMessages: [msg('@ivy', 'note to self', '@ivy')],
            stimuli: [msg('@nova', 'new')],
        }));

        const call = llm.process.mock.calls[0][0];
        expect(call.text).toContain('## Identity');
        expect(call.text).toContain('## Public chatroom (recent)');
        expect(call.text).toContain('## Your private messages (recent)');
        expect(call.text).toContain('## New messages since last check');
    });

    it('includes wake context section in prompt', async () => {
        const llm = mockLLM({});
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await agent.think(baseContext({
            wakeMode: 'mentions',
            heartbeatMs: 30000,
        }));

        const call = llm.process.mock.calls[0][0];
        expect(call.text).toContain('## Attention settings');
        expect(call.text).toContain('mentions');
    });

    it('returns two CallActions when LLM emits calls with two entries', async () => {
        const llm = mockLLM({ calls: [{ tool: 'text/write', args: { path: '/home/a.md', content: 'hi' } }, { tool: 'text/write', args: { path: '/home/b.md', content: 'bye' } }] });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext());
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ type: 'call', tool: 'text/write', args: { path: '/home/a.md', content: 'hi' } });
        expect(result[1]).toEqual({ type: 'call', tool: 'text/write', args: { path: '/home/b.md', content: 'bye' } });
    });

    it('returns no CallActions when LLM emits calls: []', async () => {
        const llm = mockLLM({ calls: [] });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext());
        expect(result).toEqual([]);
    });

    it('throws when LLM emits calls with more than 5 entries', async () => {
        const llm = mockLLM({
            calls: [
                { tool: 'a' }, { tool: 'b' }, { tool: 'c' },
                { tool: 'd' }, { tool: 'e' }, { tool: 'f' },
            ],
        });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await expect(agent.think(baseContext())).rejects.toThrow('calls must not exceed 5 entries per tick');
    });

    it('throws when LLM emits calls as non-array', async () => {
        const llm = mockLLM({ calls: { tool: 'a' } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await expect(agent.think(baseContext())).rejects.toThrow('calls must be an array');
    });

    it('throws when a calls entry is missing tool', async () => {
        const llm = mockLLM({ calls: [{ tool: 'ok' }, { args: {} }] });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        await expect(agent.think(baseContext())).rejects.toThrow('calls[1].tool must be a non-empty string');
    });

    it('returns coordinate action when LLM provides coordinate field', async () => {
        const llm = mockLLM({ coordinate: { to: '@nova', text: 'handoff: please continue' } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext());
        expect(result).toEqual([{ type: 'coordinate', to: '@nova', text: 'handoff: please continue' }]);
    });

    it('validates coordinate requires non-empty to and text', async () => {
        const llm = mockLLM({ coordinate: { to: '', text: 'hi' } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);
        await expect(agent.think(baseContext())).rejects.toThrow('coordinate.to must be a non-empty string');
    });

    it('returns configure with context window fields', async () => {
        const llm = mockLLM({ configure: { publicContextWindow: 10, privateContextWindow: 5, internalContextWindow: 8 } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);

        const result = await agent.think(baseContext());
        expect(result).toEqual([{ type: 'configure', publicContextWindow: 10, privateContextWindow: 5, internalContextWindow: 8 }]);
    });

    it('rejects configure.publicContextWindow below minimum', async () => {
        const llm = mockLLM({ configure: { publicContextWindow: 3 } });
        const agent = new LLMAgent({ handle: '@ivy', displayName: 'Ivy', systemPrompt: 'test' }, llm);
        await expect(agent.think(baseContext())).rejects.toThrow(/publicContextWindow.*must be an integer >= 5/i);
    });
});

// ─── AgentParticipant (adapter) ─────────────────────────────────

describe('AgentParticipant', () => {
    let room: Room;

    beforeEach(() => {
        room = new Room(new RoomLog(createTestDatabase()));
    });

    it('routes speak action to room.post()', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'speak', text: 'hello back' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const other = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(other);

        participant.start();
        participant.receive(msg('@nova', 'hi'));

        await vi.waitFor(() => {
            expect(other.receive).toHaveBeenCalled();
        });

        participant.stop();
        const lastMsg = other.receive.mock.calls.at(-1)?.[0] as Message;
        expect(lastMsg.from).toBe('@ivy');
        expect(lastMsg.text).toBe('hello back');
        expect(lastMsg.to).toBe('*');
    });

    it('routes dm action to room.dm()', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'dm', to: '@nova', text: 'secret reply' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        const arch = { handle: '@architect', displayName: 'Architect', receive: vi.fn() };
        room.join(participant);
        room.join(nova);
        room.join(arch);

        participant.start();
        participant.receive(msg('@nova', 'psst', '@ivy'));

        await vi.waitFor(() => {
            expect(nova.receive).toHaveBeenCalled();
        });

        participant.stop();
        const lastMsg = nova.receive.mock.calls.at(-1)?.[0] as Message;
        expect(lastMsg.from).toBe('@ivy');
        expect(lastMsg.to).toBe('@nova');
        // Architect should NOT have received the DM
        const archMsgs = arch.receive.mock.calls.map(c => c[0] as Message);
        expect(archMsgs.every(m => m.to !== '@nova')).toBe(true);
    });

    it('stays silent when agent returns empty actions', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'hi'));

        // Give the loop time to process
        await new Promise(r => setTimeout(r, 50));
        participant.stop();

        // Agent.think was called but no response posted
        expect(agent.think).toHaveBeenCalledOnce();
        // Nova only got the original stimulus notification, not a response from @ivy
        expect(nova.receive).not.toHaveBeenCalled();
    });

    it('routes note action to room.note() (hidden from others)', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'note', text: 'thinking...' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'trigger'));

        await new Promise(r => setTimeout(r, 60));
        participant.stop();

        expect(nova.receive).not.toHaveBeenCalled();
        const internal = room.getInternal('@ivy');
        expect(internal.some(m => m.text === 'thinking...')).toBe(true);
    });

    it('applies configure action to update wake mode', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'configure', wakeOn: 'mentions' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'hello'));

        await vi.waitFor(() => {
            expect(agent.think).toHaveBeenCalledOnce();
        });
        participant.stop();

        // Verify think was called with wakeMode: 'all' initially (before configure took effect)
        const ctx = (agent.think as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentContext;
        expect(ctx.wakeMode).toBe('all');
    });

    it('does not wake on non-qualifying messages when wakeMode is dm', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([]),
        };

        const participant = new AgentParticipant(agent, room, { wakeMode: 'dm' });
        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        // Broadcast message — should NOT wake the agent
        participant.receive(msg('@nova', 'hello everyone'));

        await new Promise(r => setTimeout(r, 50));
        participant.stop();

        // think should not have been called since broadcast doesn't qualify under 'dm' mode
        expect(agent.think).not.toHaveBeenCalled();
    });

    it('wakes on DM when wakeMode is dm', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([]),
        };

        const participant = new AgentParticipant(agent, room, { wakeMode: 'dm' });
        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        // Direct message — should wake the agent
        participant.receive(msg('@nova', 'psst', '@ivy'));

        await vi.waitFor(() => {
            expect(agent.think).toHaveBeenCalledOnce();
        });
        participant.stop();
    });

    it('wakes on mention when wakeMode is mentions', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([]),
        };

        const participant = new AgentParticipant(agent, room, { wakeMode: 'mentions' });
        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        // Non-mention broadcast — no wake
        participant.receive(msg('@nova', 'hello world', '*', '1'));
        await new Promise(r => setTimeout(r, 30));
        expect(agent.think).not.toHaveBeenCalled();

        // Mention — should wake
        participant.receive(msg('@nova', 'hey @ivy what do you think?', '*', '2'));
        await vi.waitFor(() => {
            expect(agent.think).toHaveBeenCalled();
        });
        participant.stop();
    });

    it('passes wakeMode and heartbeatMs in assembled context', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([]),
        };

        const participant = new AgentParticipant(agent, room, { wakeMode: 'mentions', heartbeatMs: 60000 });
        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'hey @ivy', '*', '1'));

        await vi.waitFor(() => {
            expect(agent.think).toHaveBeenCalledOnce();
        });
        participant.stop();

        const ctx = (agent.think as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentContext;
        expect(ctx.wakeMode).toBe('mentions');
        expect(ctx.heartbeatMs).toBe(60000);
    });

    it('assembles context with public + private + internal + stimuli', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);

        // Seed some history before starting the loop
        room.post('@nova', 'public msg');
        room.dm('@nova', '@ivy', 'private msg');
        room.note('@ivy', 'internal note');

        // Drain the stimuli that were delivered during seeding
        // (the loop isn't running yet — they're sitting in the queue).
        // Start now so the next receive() triggers a fresh batch.
        participant.start();

        await vi.waitFor(() => {
            expect(agent.think).toHaveBeenCalled();
        });

        // First call processed the seed messages. Now send a fresh stimulus.
        (agent.think as ReturnType<typeof vi.fn>).mockClear();
        participant.receive(msg('@nova', 'hey @ivy'));

        await vi.waitFor(() => {
            expect(agent.think).toHaveBeenCalled();
        });

        participant.stop();

        const ctx = (agent.think as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentContext;
        expect(ctx.publicMessages.length).toBeGreaterThanOrEqual(1);
        expect(ctx.privateMessages.length).toBeGreaterThanOrEqual(1);
        expect(ctx.internalMessages.length).toBeGreaterThanOrEqual(1);
        expect(ctx.stimuli).toHaveLength(1);
        expect(ctx.stimuli[0].text).toBe('hey @ivy');
        expect(ctx.isMentioned).toBe(true);
    });

    it('adds warning message and drops response when DM target does not exist', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'dm', to: '@ghost', text: 'private secret' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'hello'));

        await vi.waitFor(() => {
            expect(nova.receive).toHaveBeenCalled();
        });
        participant.stop();

        const seen = nova.receive.mock.calls.map(c => c[0] as Message);
        expect(seen.some(m => m.text.includes('Cannot send private message to @ghost'))).toBe(true);
        expect(seen.some(m => m.text === 'private secret')).toBe(false);
    });

    it('adds warning message when response mentions non-existing handles', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'speak', text: 'Ping @ghost for details.' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'hello'));

        await vi.waitFor(() => {
            expect(nova.receive).toHaveBeenCalled();
        });
        participant.stop();

        const seen = nova.receive.mock.calls.map(c => c[0] as Message);
        expect(seen.some(m => m.text === 'Ping @ghost for details.')).toBe(true);
        expect(seen.some(m => m.text.includes('Unknown handle mention(s): @ghost'))).toBe(true);
    });

    it('routes coordinate action as a DM to the target', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'coordinate', to: '@nova', text: 'take it from here' }] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(participant);
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'hi'));

        await vi.waitFor(() => {
            expect(nova.receive).toHaveBeenCalled();
        });
        participant.stop();

        const lastMsg = nova.receive.mock.calls.at(-1)?.[0] as Message;
        expect(lastMsg.from).toBe('@ivy');
        expect(lastMsg.to).toBe('@nova');
        expect(lastMsg.text).toBe('take it from here');
    });

    it('applies configure context window fields', async () => {
        let callCount = 0;
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve([{ type: 'configure', publicContextWindow: 7 }] satisfies AgentAction[]);
                }
                return Promise.resolve([]);
            }),
        };

        const participant = new AgentParticipant(agent, room);
        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'first'));

        await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));

        participant.receive(msg('@nova', 'second'));
        await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2));
        participant.stop();

        // On second think(), the context should reflect the updated window.
        const ctx2 = (agent.think as ReturnType<typeof vi.fn>).mock.calls[1][0] as AgentContext;
        expect(ctx2.publicContextWindow).toBe(7);
    });

    it('aborts remaining call actions in batch after first failure and posts combined note', async () => {
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([
                { type: 'call', tool: 'text/write', args: { path: '/home/a.md' } },
                { type: 'call', tool: 'text/write', args: { path: '/home/b.md' } },
                { type: 'call', tool: 'text/write', args: { path: '/home/c.md' } },
            ] satisfies AgentAction[]),
        };

        const participant = new AgentParticipant(agent, room);

        // Inject a mock call handler: first call fails, others would succeed.
        const mockHandle = vi.fn()
            .mockRejectedValueOnce(new Error('disk full'))
            .mockResolvedValue('ok');
        (participant as any).actionHandlers.set('call', { type: 'call', handle: mockHandle });

        room.join(participant);
        const nova = { handle: '@nova', displayName: 'Nova', receive: vi.fn() };
        room.join(nova);

        participant.start();
        participant.receive(msg('@nova', 'go'));

        await vi.waitFor(() => {
            expect(room.getInternal('@ivy').some(n => n.text.includes('[calls: 3 ops]'))).toBe(true);
        });
        participant.stop();

        // Only one call handler invocation (the failing one); the other two were skipped.
        expect(mockHandle).toHaveBeenCalledTimes(1);

        // All results are combined into a single note.
        const notes = room.getInternal('@ivy');
        const batchNote = notes.find(n => n.text.includes('[calls: 3 ops]'));
        expect(batchNote).toBeDefined();
        expect(batchNote!.text).toContain('Error: disk full');
        expect(batchNote!.text).toContain('[batch]');
        expect(batchNote!.text).toContain('2 remaining');
    });
});

// ─── Config persistence (IStore) ────────────────────────────────

describe('AgentParticipant — config persistence', () => {
    let room: Room;

    beforeEach(() => {
        room = new Room(new RoomLog(createTestDatabase()));
    });

    it('restores heartbeatMs from store on start', async () => {
        const store = new MemoryStore();
        await store.set('ivy:agent:@ivy:config', { heartbeatMs: 42000, wakeMode: 'mentions' });

        const agent: Agent = { handle: '@ivy', displayName: 'Ivy', think: vi.fn().mockResolvedValue([]) };
        const participant = new AgentParticipant(agent, room, { store });
        room.join(participant);
        room.join({ handle: '@nova', displayName: 'Nova', receive: vi.fn() });

        participant.start();
        participant.receive(msg('@nova', 'hey @ivy'));

        await vi.waitFor(() => expect(agent.think).toHaveBeenCalled());
        participant.stop();

        const ctx = (agent.think as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentContext;
        expect(ctx.heartbeatMs).toBe(42000);
        expect(ctx.wakeMode).toBe('mentions');
    });

    it('persists config to store after a configure action', async () => {
        const store = new MemoryStore();
        const agent: Agent = {
            handle: '@ivy',
            displayName: 'Ivy',
            think: vi.fn().mockResolvedValue([{ type: 'configure', heartbeatMs: 99000, wakeOn: 'dm' }]),
        };
        const participant = new AgentParticipant(agent, room, { store });
        room.join(participant);
        room.join({ handle: '@nova', displayName: 'Nova', receive: vi.fn() });

        participant.start();
        participant.receive(msg('@nova', 'hey @ivy'));

        await vi.waitFor(async () => {
            const saved = await store.get<any>('ivy:agent:@ivy:config');
            expect(saved?.heartbeatMs).toBe(99000);
        });
        participant.stop();

        const saved = await store.get<any>('ivy:agent:@ivy:config');
        expect(saved?.wakeMode).toBe('dm');
    });

    it('explicit constructor config overrides persisted value', async () => {
        const store = new MemoryStore();
        await store.set('ivy:agent:@ivy:config', { heartbeatMs: 42000 });

        const agent: Agent = { handle: '@ivy', displayName: 'Ivy', think: vi.fn().mockResolvedValue([]) };
        // Explicit heartbeatMs: 5000 in constructor — should win over stored 42000.
        const participant = new AgentParticipant(agent, room, { store, heartbeatMs: 5000 });
        room.join(participant);
        room.join({ handle: '@nova', displayName: 'Nova', receive: vi.fn() });

        participant.start();
        participant.receive(msg('@nova', 'hey @ivy'));

        await vi.waitFor(() => expect(agent.think).toHaveBeenCalled());
        participant.stop();

        const ctx = (agent.think as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentContext;
        expect(ctx.heartbeatMs).toBe(5000);
    });

    it('works without a store (no-op, no errors)', async () => {
        const agent: Agent = { handle: '@ivy', displayName: 'Ivy', think: vi.fn().mockResolvedValue([]) };
        const participant = new AgentParticipant(agent, room); // no store
        room.join(participant);
        room.join({ handle: '@nova', displayName: 'Nova', receive: vi.fn() });

        participant.start();
        participant.receive(msg('@nova', 'hey @ivy'));

        await vi.waitFor(() => expect(agent.think).toHaveBeenCalled());
        participant.stop();
    });
});
