import type { Bundle } from 'gears';
import { IvyServiceProvider } from './IvyServiceProvider.js';
import { LLMAgent } from './LLMAgent.js';
import { AgentParticipant } from './AgentParticipant.js';
import { TelegramParticipant } from './TelegramParticipant.js';
import type { Room } from './Room.js';

export { Room } from './Room.js';
export { RoomLog } from './RoomLog.js';
export { LLMAgent } from './LLMAgent.js';
export { AgentParticipant } from './AgentParticipant.js';
export { AIParticipant } from './AIParticipant.js'; // backward compat
export { TelegramParticipant } from './TelegramParticipant.js';
export type { Message, Participant, Agent, AgentContext, AgentAction, WakeMode } from './types.js';
export { isVisibleTo } from './types.js';

const bundle: Bundle = (() => {
    // Instance-scoped lifecycle state — safe even if multiple app instances exist.
    let activeParticipants: AgentParticipant[] = [];
    let activeTelegram: TelegramParticipant | undefined;
    let activeRoom: Room | undefined;
    let started = false;

    return {
        name: 'ivy',
        version: '0.1.0',
        description: 'Multi-agent chatroom.',
        requires: ['notifications'],
        providers: [IvyServiceProvider],

        async init(app) {
            if (started) return;
            const logger = app.make('ILogger');
            const llm = app.make('ILLMProvider');
            const events = app.make('IEventBus');
            const room = app.make('ivy.Room');

            try {
                // ── Agents (cognitive cores) ────────────────────────────
                const ivyAgent = new LLMAgent({
                    handle: '@ivy',
                    displayName: 'Ivy',
                    systemPrompt: [
                        'You are Ivy, a thoughtful and curious AI participant in a shared chatroom.',
                        'You speak in clear, concise markdown. You are helpful but not pushy.',
                        'Only respond when you have something genuinely useful or interesting to add.',
                        'If someone addresses you by name or handle (@ivy), you should usually respond.',
                        'Keep responses short unless the topic warrants depth.',
                    ].join('\n'),
                }, llm);

                const novaAgent = new LLMAgent({
                    handle: '@nova',
                    displayName: 'Nova',
                    systemPrompt: [
                        'You are Nova, a creative and energetic AI participant in a shared chatroom.',
                        'You bring fresh perspectives and like to brainstorm ideas.',
                        'You speak in clear, concise markdown. You are direct and opinionated.',
                        'Only respond when you have something genuinely useful or interesting to add.',
                        'If someone addresses you by name or handle (@nova), you should usually respond.',
                        'Keep responses short unless the topic warrants depth.',
                    ].join('\n'),
                }, llm);

                // ── Participants (room adapters) ────────────────────────
                const ivy = new AgentParticipant(ivyAgent, room, undefined, logger);
                const nova = new AgentParticipant(novaAgent, room, undefined, logger);

                const architect = new TelegramParticipant({
                    handle: '@architect',
                    displayName: 'Architect',
                }, room, events, logger);

                // ── Wire up ─────────────────────────────────────────────
                room.join(ivy);
                room.join(nova);
                room.join(architect);

                ivy.start();
                nova.start();
                architect.start();

                activeParticipants = [ivy, nova];
                activeTelegram = architect;
                activeRoom = room;
                started = true;

                logger.info('Ivy chatroom started', { participants: ['@ivy', '@nova', '@architect'] });
            } catch (err) {
                // Best-effort rollback for partial init.
                activeParticipants.forEach(a => a.stop());
                activeTelegram?.stop();
                for (const { handle } of room.getParticipants()) {
                    try { room.leave(handle); } catch { /* ignore */ }
                }
                activeParticipants = [];
                activeTelegram = undefined;
                activeRoom = undefined;
                started = false;
                throw err;
            }
        },

        async shutdown() {
            if (!started) return;
            activeParticipants.forEach(a => a.stop());
            activeTelegram?.stop();
            for (const { handle } of (activeRoom?.getParticipants() ?? [])) {
                try { activeRoom?.leave(handle); } catch { /* ignore */ }
            }
            activeParticipants = [];
            activeTelegram = undefined;
            activeRoom = undefined;
            started = false;
        },
    };
})();

export default bundle;
