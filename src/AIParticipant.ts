/**
 * AIParticipant — backward-compat convenience wrapper.
 *
 * Combines LLMAgent + AgentParticipant into one constructor call
 * matching the original API. New code should prefer using LLMAgent
 * and AgentParticipant directly.
 *
 * Limitation: promptTokenBudget and packs are not exposed here and
 * use defaults from src/constants.ts.
 * If you need to configure those, use LLMAgent + AgentParticipant.
 */

import type { ILLMProvider } from 'gears';
import type { ILogger } from 'gears';
import type { Message, Participant, WakeMode } from './types.js';
import type { Room } from './Room.js';
import { LLMAgent } from './LLMAgent.js';
import { AgentParticipant } from './AgentParticipant.js';

export interface AIParticipantConfig {
    handle: string;
    displayName: string;
    systemPrompt: string;
    /** Max recent messages to include as context. Default from src/constants.ts */
    contextWindow?: number;
    /** Initial wake-on-message setting. Default from src/constants.ts */
    wakeMode?: WakeMode;
    /** Initial heartbeat interval in ms. null = disabled. Default from src/constants.ts */
    heartbeatMs?: number | null;
}

export class AIParticipant implements Participant {
    readonly handle: string;
    readonly displayName: string;

    private inner: AgentParticipant;

    constructor(config: AIParticipantConfig, room: Room, llm: ILLMProvider, logger?: ILogger) {
        const agent = new LLMAgent({
            handle: config.handle,
            displayName: config.displayName,
            systemPrompt: config.systemPrompt,
        }, llm);

        this.inner = new AgentParticipant(agent, room, {
            contextWindow: config.contextWindow,
            wakeMode: config.wakeMode,
            heartbeatMs: config.heartbeatMs,
        }, logger);

        this.handle = this.inner.handle;
        this.displayName = this.inner.displayName;
    }

    receive(message: Message): void { this.inner.receive(message); }
    start(): void { this.inner.start(); }
    stop(): void { this.inner.stop(); }
}
