import * as fsSync from 'node:fs';
import type { IPromptContributor, PromptSection } from '@nucleic-se/gears/agentic';
import { estimateTokens } from '@nucleic-se/gears/agentic';
import type { IvyAgentPack, IvyPromptContext } from './types.js';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { MAX_CALLS_PER_TICK } from '../constants.js';

const MAX_AGENTS_MD_BYTES  = 16 * 1024; // 16 KB cap — instructions, not a novel
const MAX_CONTEXT_MD_BYTES = 16 * 1024; // 16 KB cap — working memory, not a log

// ─── Contributors ────────────────────────────────────────────────

/**
 * Tells the agent it has a sandbox and describes the directory layout.
 * Context-aware — includes the agent's own home path (/home/<handle>/).
 * Sticky — always present so the agent never forgets it has file access.
 */
const SandboxIdentityContributor: IPromptContributor<IvyPromptContext> = {
    id: 'sandbox.identity',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const handle = ctx.handle.replace(/^@/, '');
        const homePath = `/home/${handle}`;
        const text = [
            '## Sandbox',
            'You have access to a shared persistent sandbox filesystem. All paths are absolute.',
            'Layout:',
            `  ${homePath.padEnd(16)} — your private workspace (read-write, persistent)`,
            '  /tmp              — scratch space (read-write, may be cleared)',
            '  /tools            — tool groups (read-only; use text/tree to browse)',
            '  /data             — shared read-write space for all agents',
            'Write and rm on / and /tools are rejected by the runtime, not just policy.',
            'File reads and writes are limited to 512 KB.',
        ].join('\n');
        return [section('sandbox.identity', text, 98, true, 'constraint')];
    },
};

/**
 * Documents the calls action schema.
 * Sticky — always present so the agent has the invocation contract.
 */
const SandboxCallContributor: IPromptContributor<IvyPromptContext> = {
    id: 'sandbox.call',
    contribute(): PromptSection[] {
        const text = [
            '## Tool invocation (calls action)',
            'Use "calls" ONLY for sandbox tools (e.g. text/read, json/get, schedule/set, fetch/get).',
            'NEVER put "speak", "dm", "note", "fs", or "configure" in calls — those are top-level response fields.',
            'Single:  {"calls": [{"tool": "text/read", "args": {"path": "/home/nova/CONTEXT.md"}}]}',
            `Batch:   {"calls": [{"tool": "text/write", "args": {...}}, {"tool": "validate/run", "args": {...}}]}  — max ${MAX_CALLS_PER_TICK} per tick`,
            'Always include every required arg — omitting one aborts the entire batch.',
            'Results arrive as internal notes on your next wake. If one call fails the rest are skipped.',
        ].join('\n');
        return [section('sandbox.call', text, 86, true, 'constraint')];
    },
};

/**
 * Dynamically lists tools available in the sandbox at prompt-build time.
 * Non-sticky — can be dropped under token pressure; the agent can recover
 * with text/tree on /tools.
 */
class SandboxToolsContributor implements IPromptContributor<IvyPromptContext> {
    id = 'sandbox.tools';

    constructor(private sandbox: Sandbox) {}

    contribute(): PromptSection[] {
        const tools = this.sandbox.listTools();
        const lines = tools.length > 0
            ? tools.map(t => {
                const qualName = t.group ? `${t.group}/${t.name}` : t.name;
                return `  ${qualName.padEnd(22)} ${t.description}`;
            })
            : ['  (none)'];
        const text = ['## Available tools (/tools)', ...lines].join('\n');
        return [section('sandbox.tools', text, 71, false, 'task')];
    }
}

/**
 * Reads AGENTS.md files from the sandbox and injects them near the top of
 * the prompt. Three files are checked, in order:
 *
 *   /AGENTS.md                      — operator instructions (root is read-only to agents)
 *   /home/<handle>/AGENTS.md        — architect-set personal identity (read-only to agents)
 *   /home/<handle>/CORRECTIONS.md   — agent-authored corrections (writable by agent)
 *
 * Each file is silently skipped if absent or empty.
 */
class AgentsMdContributor implements IPromptContributor<IvyPromptContext> {
    id = 'sandbox.agents_md';

    constructor(private sandbox: Sandbox) {}

    contribute(ctx: IvyPromptContext): PromptSection[] {
        const handle = ctx.handle.replace(/^@/, '');
        return [
            ...this.readSection('/AGENTS.md',                         'sandbox.agents_md.root',        96),
            ...this.readSection(`/home/${handle}/AGENTS.md`,          'sandbox.agents_md.home',        95),
            ...this.readSection(`/home/${handle}/CORRECTIONS.md`,     'sandbox.agents_md.corrections', 94),
        ];
    }

    private readSection(agentPath: string, id: string, priority: number): PromptSection[] {
        let real: string;
        try {
            real = this.sandbox.resolveExisting(agentPath);
        } catch {
            return [];
        }
        const st = fsSync.statSync(real);
        if (st.isDirectory() || st.size === 0 || st.size > MAX_AGENTS_MD_BYTES) return [];
        const content = fsSync.readFileSync(real, 'utf-8').trim();
        if (!content) return [];
        return [section(id, content, priority, true, 'constraint')];
    }
}

/**
 * Reads CONTEXT.md files and injects them as pinned working memory.
 * Two files are checked, in order:
 *
 *   /CONTEXT.md               — global context (operator-managed, read-only to agents)
 *   /home/<handle>/CONTEXT.md — personal context (agent-editable; intended for
 *                               temporary pins: active tasks, pending decisions, etc.)
 *
 * Sticky so pinned context survives token pressure. Lower priority than AGENTS.md
 * so identity/instructions always come first.
 */
class ContextMdContributor implements IPromptContributor<IvyPromptContext> {
    id = 'sandbox.context_md';

    constructor(private sandbox: Sandbox) {}

    contribute(ctx: IvyPromptContext): PromptSection[] {
        const handle = ctx.handle.replace(/^@/, '');
        return [
            ...this.readSection('/CONTEXT.md',                  'sandbox.context_md.root', 92),
            ...this.readSection(`/home/${handle}/CONTEXT.md`,   'sandbox.context_md.home', 90),
        ];
    }

    private readSection(agentPath: string, id: string, priority: number): PromptSection[] {
        let real: string;
        try {
            real = this.sandbox.resolveExisting(agentPath);
        } catch {
            return [];
        }
        const st = fsSync.statSync(real);
        if (st.isDirectory() || st.size === 0 || st.size > MAX_CONTEXT_MD_BYTES) return [];
        const content = fsSync.readFileSync(real, 'utf-8').trim();
        if (!content) return [];
        return [section(id, content, priority, true, 'task')];
    }
}

// ─── Pack ────────────────────────────────────────────────────────

export class SandboxAgentPack implements IvyAgentPack {
    id = 'sandbox';

    constructor(private sandbox: Sandbox, private agentHandle: string) {}

    register(ctx: { promptRegistry: import('@nucleic-se/gears/agentic').IPromptContributorRegistry<IvyPromptContext> }): void {
        this.sandbox.ensureAgentHome(this.agentHandle);
        ctx.promptRegistry.register(SandboxIdentityContributor);
        ctx.promptRegistry.register(SandboxCallContributor);
        ctx.promptRegistry.register(new SandboxToolsContributor(this.sandbox));
        ctx.promptRegistry.register(new AgentsMdContributor(this.sandbox));
        ctx.promptRegistry.register(new ContextMdContributor(this.sandbox));
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

function section(
    id: string,
    text: string,
    priority: number,
    sticky: boolean,
    phase: import('@nucleic-se/gears/agentic').PromptSectionPhase,
): PromptSection {
    return {
        id,
        priority,
        weight: 1,
        estimatedTokens: estimateTokens(text),
        tags: ['ivy', 'sandbox'],
        sticky,
        phase,
        text: () => text,
    };
}
