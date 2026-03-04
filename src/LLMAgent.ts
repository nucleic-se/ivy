/**
 * LLMAgent — pure cognitive core backed by an LLM.
 *
 * Implements the Agent interface. Has no knowledge of rooms, queues,
 * or transport. Receives assembled context, calls the LLM once per
 * think() invocation, and returns an action list.
 *
 * At most one speak, one dm, one note, and one configure per response.
 * Sandbox tool calls go in the `calls` array (max 5 per tick).
 * There is no top-level `fs` field — use calls with text/* tools instead.
 */

import type { ILLMProvider } from '@nucleic-se/gears';
import { AIPromptService, PromptContributorRegistry, PromptEngine } from '@nucleic-se/gears/agentic';
import type { Agent, AgentAction, AgentContext, CoordinateAction, WakeMode } from './types.js';
import type { IvyPromptContext } from './packs/types.js';
import type { Sandbox } from './sandbox/Sandbox.js';
import { bootInternalPacks } from './packs/index.js';
import { SandboxAgentPack } from './packs/sandbox-prompt.js';
import { DEFAULT_AGENT_PACKS, DEFAULT_PROMPT_TOKEN_BUDGET } from './constants.js';

export interface LLMAgentConfig {
    handle: string;
    displayName: string;
    systemPrompt: string;
    promptTokenBudget?: number;
    /** Internal packs only (self-contained). */
    packs?: string[];
    /** Sandbox to expose to the agent via prompt contributors. */
    sandbox?: Sandbox;
}

interface ThinkResult {
    speak?: string;
    dm?: { to: string; text: string };
    coordinate?: { to: string; text: string };
    note?: string;
    configure?: {
        wakeOn?: WakeMode;
        heartbeatMs?: number | null;
        publicContextWindow?: number;
        privateContextWindow?: number;
        internalContextWindow?: number;
    };
    calls?: Array<{ tool: string; args?: Record<string, unknown> }>;
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
        coordinate: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Receiving agent handle, e.g. "@nova".' },
                text: { type: 'string', description: 'Handoff message content.' },
            },
            required: ['to', 'text'],
            description: 'Semantic alias for dm: signal an inter-agent work handoff. Routed identically to dm.',
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
                publicContextWindow: {
                    type: 'number',
                    minimum: 5,
                    description: 'Max public messages to include in context (min 5).',
                },
                privateContextWindow: {
                    type: 'number',
                    minimum: 3,
                    description: 'Max private DMs to include in context (min 3).',
                },
                internalContextWindow: {
                    type: 'number',
                    minimum: 3,
                    description: 'Max internal notes to include in context (min 3).',
                },
            },
            description: 'Adjust your wake, heartbeat, and context window settings.',
        },
        calls: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    tool: { type: 'string', description: 'Sandbox tool path as listed in /tools (e.g. "text/read", "json/get", "schedule/set"). Never use "dm", "speak", "note", "fs", or "configure" here — those are separate top-level response fields.' },
                    args: { type: 'object', description: 'Arguments to pass to the tool.' },
                },
                required: ['tool'],
            },
            maxItems: 5,
            description: 'Sandbox tool calls ONLY (e.g. text/read, json/set, schedule/list). NEVER use this for dm, speak, note, fs, or configure — those are top-level fields. Use multiple entries for atomic multi-step operations. Maximum 5.',
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
        if (config.sandbox) {
            new SandboxAgentPack(config.sandbox, config.handle).register({ promptRegistry: this.promptRegistry });
        }
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
            .transform((raw: ThinkResult) => this.validateThinkResult(this.coerceThinkResult(raw)))
            .retry(1)
            .run();

        const actions: AgentAction[] = [];

        if (result.speak?.trim()) {
            actions.push({ type: 'speak', text: result.speak.trim() });
        }
        if (result.dm) {
            actions.push({ type: 'dm', to: result.dm.to, text: result.dm.text });
        }
        if (result.coordinate) {
            actions.push({ type: 'coordinate', to: result.coordinate.to, text: result.coordinate.text } satisfies CoordinateAction);
        }
        if (result.note?.trim()) {
            actions.push({ type: 'note', text: result.note.trim() });
        }
        const configure = this.normalizeConfigure(result.configure);
        if (configure !== undefined) {
            actions.push({ type: 'configure', ...configure });
        }
        for (const c of result.calls ?? []) {
            actions.push({ type: 'call', tool: c.tool, args: c.args });
        }

        return actions;
    }

    /**
     * Rescue common Haiku/small-model mistakes before validation:
     * - `calls` as a non-array single object → wrap in array
     * - Top-level action names (speak, dm, note, coordinate, configure) in calls[] → promote to top-level fields
     */
    private coerceThinkResult(raw: ThinkResult): ThinkResult {
        if (typeof raw !== 'object' || raw === null) return raw;
        const result: ThinkResult = { ...raw };

        // Wrap non-array calls in an array.
        if (result.calls !== undefined && !Array.isArray(result.calls)) {
            result.calls = (typeof result.calls === 'object' && result.calls !== null)
                ? [result.calls as { tool: string; args?: Record<string, unknown> }]
                : [];
        }

        if (!Array.isArray(result.calls) || result.calls.length === 0) return result;

        // Lift well-known action names out of calls[] into their proper top-level fields.
        const remaining: Array<{ tool: string; args?: Record<string, unknown> }> = [];
        for (const call of result.calls) {
            if (typeof call !== 'object' || call === null || typeof (call as any).tool !== 'string') {
                remaining.push(call);
                continue;
            }
            const args = ((call as any).args ?? {}) as Record<string, unknown>;
            switch ((call as any).tool) {
                case 'speak':
                    if (result.speak === undefined && typeof args['text'] === 'string') result.speak = args['text'];
                    break;
                case 'note':
                    if (result.note === undefined && typeof args['text'] === 'string') result.note = args['text'];
                    break;
                case 'dm':
                    if (result.dm === undefined && typeof args['to'] === 'string' && typeof args['text'] === 'string')
                        result.dm = { to: args['to'], text: args['text'] };
                    break;
                case 'coordinate':
                    if (result.coordinate === undefined && typeof args['to'] === 'string' && typeof args['text'] === 'string')
                        result.coordinate = { to: args['to'], text: args['text'] };
                    break;
                case 'configure':
                    if (result.configure === undefined && typeof args === 'object')
                        result.configure = args as ThinkResult['configure'];
                    break;
                default:
                    remaining.push(call);
            }
        }
        result.calls = remaining;
        return result;
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
        if (raw.coordinate !== undefined) {
            if (typeof raw.coordinate !== 'object' || raw.coordinate === null) throw new Error('LLM output coordinate must be an object');
            if (typeof raw.coordinate.to !== 'string' || !raw.coordinate.to.trim()) throw new Error('LLM output coordinate.to must be a non-empty string');
            if (typeof raw.coordinate.text !== 'string' || !raw.coordinate.text.trim()) throw new Error('LLM output coordinate.text must be a non-empty string');
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
            for (const [field, min] of [
                ['publicContextWindow', 5],
                ['privateContextWindow', 3],
                ['internalContextWindow', 3],
            ] as const) {
                const v = (c as Record<string, unknown>)[field];
                if (v !== undefined) {
                    if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) < min) {
                        throw new Error(`LLM output configure.${field} must be an integer >= ${min}`);
                    }
                }
            }
        }
        if (raw.calls !== undefined) {
            if (!Array.isArray(raw.calls))
                throw new Error('LLM output calls must be an array');
            if (raw.calls.length > 5)
                throw new Error('LLM output calls must not exceed 5 entries per tick');
            for (const [i, c] of (raw.calls as unknown[]).entries()) {
                if (typeof c !== 'object' || c === null)
                    throw new Error(`LLM output calls[${i}] must be an object`);
                if (typeof (c as any).tool !== 'string' || !(c as any).tool.trim())
                    throw new Error(`LLM output calls[${i}].tool must be a non-empty string`);
            }
        }
        return raw;
    }

    /**
     * Keep heartbeat sticky unless the model explicitly disables it.
     * Some providers may emit heartbeatMs:null alongside unrelated configure fields.
     * Treat that mixed-null as "unchanged" so heartbeat keeps ticking.
     */
    private normalizeConfigure(configure: ThinkResult['configure']): ThinkResult['configure'] | undefined {
        if (configure === undefined) return undefined;
        const normalized: NonNullable<ThinkResult['configure']> = {};

        if (configure.wakeOn !== undefined) normalized.wakeOn = configure.wakeOn;
        if (configure.publicContextWindow !== undefined) normalized.publicContextWindow = configure.publicContextWindow;
        if (configure.privateContextWindow !== undefined) normalized.privateContextWindow = configure.privateContextWindow;
        if (configure.internalContextWindow !== undefined) normalized.internalContextWindow = configure.internalContextWindow;

        if (configure.heartbeatMs !== undefined) {
            const hasOtherFields = configure.wakeOn !== undefined
                || configure.publicContextWindow !== undefined
                || configure.privateContextWindow !== undefined
                || configure.internalContextWindow !== undefined;
            if (configure.heartbeatMs !== null || !hasOtherFields) {
                normalized.heartbeatMs = configure.heartbeatMs;
            }
        }

        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }
}
