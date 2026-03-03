/**
 * LLMAgent — pure cognitive core backed by an LLM.
 *
 * Implements the Agent interface. Has no knowledge of rooms, queues,
 * or transport. Receives assembled context, calls the LLM once per
 * think() invocation, and returns an action list.
 *
 * At most one speak, one dm, one note, and one configure per response.
 * Multiple tool calls are allowed via the `calls` array (max 5 per tick).
 */

import type { ILLMProvider } from 'gears';
import { AIPromptService, PromptContributorRegistry, PromptEngine } from 'gears/agentic';
import type { Agent, AgentAction, AgentContext, CoordinateAction, FsOp, WakeMode } from './types.js';
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
    fs?: { op: string; path: string; content?: string; dest?: string; recursive?: boolean };
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
        fs: {
            type: 'object',
            properties: {
                op: {
                    type: 'string',
                    enum: ['read', 'write', 'ls', 'mkdir', 'rm', 'stat', 'mv'],
                    description: 'Filesystem operation.',
                },
                path: { type: 'string', description: 'Absolute path within the sandbox (e.g. "/home/file.txt").' },
                content: { type: 'string', description: 'File content for write operations.' },
                dest: { type: 'string', description: 'Destination path for mv operations.' },
                recursive: { type: 'boolean', description: 'For rm: delete non-empty directories and all their contents.' },
            },
            required: ['op', 'path'],
            description: 'Perform a filesystem operation in the sandbox. Result arrives as an internal note on next wake.',
        },
        calls: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    tool: { type: 'string', description: 'Tool name as listed in /tools.' },
                    args: { type: 'object', description: 'Arguments to pass to the tool.' },
                },
                required: ['tool'],
            },
            maxItems: 5,
            description: 'Sandbox tool calls to execute this tick. Use multiple entries for atomic multi-step operations (e.g. write prose, update index, flip ledger in one shot). Maximum 5.',
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
        if (result.coordinate) {
            actions.push({ type: 'coordinate', to: result.coordinate.to, text: result.coordinate.text } satisfies CoordinateAction);
        }
        if (result.note?.trim()) {
            actions.push({ type: 'note', text: result.note.trim() });
        }
        if (result.configure !== undefined) {
            actions.push({ type: 'configure', ...result.configure });
        }
        if (result.fs) {
            actions.push({ type: 'fs', op: result.fs.op as FsOp, path: result.fs.path, content: result.fs.content, dest: result.fs.dest, recursive: result.fs.recursive });
        }
        for (const c of result.calls ?? []) {
            actions.push({ type: 'call', tool: c.tool, args: c.args });
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
        if (raw.fs !== undefined) {
            if (typeof raw.fs !== 'object' || raw.fs === null) throw new Error('LLM output fs must be an object');
            const validOps = ['read', 'write', 'ls', 'mkdir', 'rm', 'stat', 'mv'] as const;
            if (!validOps.includes(raw.fs.op as typeof validOps[number])) {
                throw new Error(`LLM output fs.op must be one of: ${validOps.join(', ')}`);
            }
            if (typeof raw.fs.path !== 'string' || !raw.fs.path.trim()) throw new Error('LLM output fs.path must be a non-empty string');
            if (raw.fs.op === 'mv' && (typeof raw.fs.dest !== 'string' || !raw.fs.dest.trim())) {
                throw new Error('LLM output fs.dest must be a non-empty string for mv');
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
}
