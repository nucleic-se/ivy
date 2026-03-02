/**
 * LLMAgent — pure cognitive core backed by an LLM.
 *
 * Implements the Agent interface. Has no knowledge of rooms, queues,
 * or transport. Receives assembled context, calls the LLM once per
 * think() invocation, and returns an action list.
 *
 * The single-call-per-tick constraint is enforced by the output schema:
 * at most one speak, one dm, one note, and one configure per response.
 * This prevents repeated/duplicate output across think steps.
 */

import type { ILLMProvider } from 'gears';
import { AIPromptService, PromptContributorRegistry, PromptEngine } from 'gears/agentic';
import type { Agent, AgentAction, AgentContext, WakeMode } from './types.js';
import type { IvyPromptContext } from './packs/types.js';
import { bootInternalPacks } from './packs/index.js';
import { DEFAULT_AGENT_PACKS, DEFAULT_PROMPT_TOKEN_BUDGET } from './constants.js';

export interface LLMAgentConfig {
    handle: string;
    displayName: string;
    systemPrompt: string;
    promptTokenBudget?: number;
    /** Internal packs only (self-contained). */
    packs?: string[];
}

interface ThinkResult {
    speak?: string;
    dm?: { to: string; text: string };
    note?: string;
    configure?: {
        wakeOn?: WakeMode;
        heartbeatMs?: number | null;
    };
}

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        speak: {
            type: 'string',
            description: 'Broadcast a public message to the chatroom. Omit to stay silent.',
        },
        dm: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient handle, e.g. "@nova".' },
                text: { type: 'string', description: 'Message content.' },
            },
            required: ['to', 'text'],
            description: 'Send a private message to a specific participant.',
        },
        note: {
            type: 'string',
            description: 'Write a private self-note visible only to you across ticks.',
        },
        configure: {
            type: 'object',
            properties: {
                wakeOn: {
                    type: 'string',
                    enum: ['all', 'mentions', 'dm', 'none'],
                    description: '"all" = wake on any message | "mentions" = only when @mentioned or DMed | "dm" = only DMs | "none" = heartbeat only',
                },
                heartbeatMs: {
                    type: ['number', 'null'],
                    description: 'Milliseconds between scheduled checks. null disables the heartbeat.',
                },
            },
            description: 'Adjust your wake and heartbeat settings.',
        },
    },
    required: [],
};

export class LLMAgent implements Agent {
    readonly handle: string;
    readonly displayName: string;
    private systemPrompt: string;
    private promptTokenBudget: number;
    private llmService: AIPromptService;
    private promptEngine = new PromptEngine();
    private promptRegistry = new PromptContributorRegistry<IvyPromptContext>();

    constructor(config: LLMAgentConfig, llm: ILLMProvider) {
        this.handle = config.handle;
        this.displayName = config.displayName;
        this.systemPrompt = config.systemPrompt;
        this.promptTokenBudget = config.promptTokenBudget ?? DEFAULT_PROMPT_TOKEN_BUDGET;
        this.llmService = new AIPromptService(llm);
        bootInternalPacks(config.packs ?? [...DEFAULT_AGENT_PACKS], this.promptRegistry);
    }

    async think(context: AgentContext): Promise<AgentAction[]> {
        const promptContext: IvyPromptContext = {
            handle: this.handle,
            displayName: this.displayName,
            context,
        };
        const sections = (await Promise.all(
            this.promptRegistry.list().map(c => c.contribute(promptContext)),
        )).flat();
        const composed = this.promptEngine.compose(sections, this.promptTokenBudget);

        const result = await this.llmService
            .pipeline(composed.text)
            .llm<ThinkResult>(b => {
                b.system(this.systemPrompt).schema(RESPONSE_SCHEMA as Record<string, unknown>);
            })
            .transform((raw: ThinkResult) => this.validateThinkResult(raw))
            .retry(1)
            .run();

        const actions: AgentAction[] = [];

        if (result.speak?.trim()) {
            actions.push({ type: 'speak', text: result.speak.trim() });
        }
        if (result.dm) {
            actions.push({ type: 'dm', to: result.dm.to, text: result.dm.text });
        }
        if (result.note?.trim()) {
            actions.push({ type: 'note', text: result.note.trim() });
        }
        if (result.configure !== undefined) {
            actions.push({ type: 'configure', ...result.configure });
        }

        return actions;
    }

    private validateThinkResult(raw: ThinkResult): ThinkResult {
        if (typeof raw !== 'object' || raw === null) {
            throw new Error('LLM output must be an object');
        }
        if (raw.speak !== undefined) {
            if (typeof raw.speak !== 'string') throw new Error('LLM output speak must be a string');
            if (!raw.speak.trim()) throw new Error('LLM output speak must be non-empty when present');
        }
        if (raw.dm !== undefined) {
            if (typeof raw.dm !== 'object' || raw.dm === null) throw new Error('LLM output dm must be an object');
            if (typeof raw.dm.to !== 'string' || !raw.dm.to.trim()) throw new Error('LLM output dm.to must be a non-empty string');
            if (typeof raw.dm.text !== 'string' || !raw.dm.text.trim()) throw new Error('LLM output dm.text must be a non-empty string');
        }
        if (raw.note !== undefined) {
            if (typeof raw.note !== 'string') throw new Error('LLM output note must be a string');
            if (!raw.note.trim()) throw new Error('LLM output note must be non-empty when present');
        }
        if (raw.configure !== undefined) {
            const c = raw.configure;
            if (typeof c !== 'object' || c === null) throw new Error('LLM output configure must be an object');
            if (c.wakeOn !== undefined && !['all', 'mentions', 'dm', 'none'].includes(c.wakeOn as string)) {
                throw new Error('LLM output configure.wakeOn must be one of: all, mentions, dm, none');
            }
            if (c.heartbeatMs !== undefined && c.heartbeatMs !== null
                && (typeof c.heartbeatMs !== 'number' || c.heartbeatMs <= 0)) {
                throw new Error('LLM output configure.heartbeatMs must be a positive number or null');
            }
        }
        return raw;
    }
}
