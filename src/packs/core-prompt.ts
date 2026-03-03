import type { IPromptContributor, PromptSection } from 'gears/agentic';
import { estimateTokens } from 'gears/agentic';
import type { IvyAgentPack, IvyPromptContext } from './types.js';

const IdentityContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.identity',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const text = [
            '## Identity',
            `You are ${ctx.displayName} (${ctx.handle}) participating in a multi-agent chatroom.`,
            'Output must match the JSON schema exactly.',
            '',
            '## Self-check (read before every response)',
            `- Your handle is ${ctx.handle}. Every message in history tagged [${ctx.handle}] or [you] is something you already said.`,
            '- Before speaking: read "## What you said recently". If you already addressed the current stimulus, return {} and stay silent.',
            '- Respond only when useful. Return {} to stay silent.',
        ].join('\n');
        return [section('core.identity', text, 100, true, 'constraint')];
    },
};

const WakeContextContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.wake-context',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const { wakeMode, heartbeatMs } = ctx.context;
        const heartbeatDesc = heartbeatMs != null ? `every ${heartbeatMs}ms` : 'off';
        const now = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
        const text = [
            '## Attention settings',
            `Date: ${now} | Wake on: ${wakeMode} | Heartbeat: ${heartbeatDesc}`,
            'Use the "configure" field to adjust these at any time.',
        ].join('\n');
        return [section('core.wake-context', text, 85, false, 'constraint')];
    },
};

const PublicHistoryContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.public-history',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const lines = ctx.context.publicMessages.map(
            m => `${fmt(m.timestamp)} [${m.from}]: ${m.text}`,
        );
        const text = [
            '## Public chatroom (recent)',
            lines.length > 0 ? lines.join('\n') : '(none)',
        ].join('\n');
        return [section('core.public-history', text, 75, false, 'history')];
    },
};

const PrivateHistoryContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.private-history',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const lines = ctx.context.privateMessages.map(
            m => `${fmt(m.timestamp)} [${m.from} -> ${m.to}]: ${m.text}`,
        );
        const text = [
            '## Your private messages (recent)',
            lines.length > 0 ? lines.join('\n') : '(none)',
        ].join('\n');
        return [section('core.private-history', text, 80, false, 'history')];
    },
};

const InternalHistoryContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.internal-history',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const lines = ctx.context.internalMessages.map(
            m => `${fmt(m.timestamp)} [self]: ${m.text}`,
        );
        const text = [
            '## Your internal notes (recent)',
            lines.length > 0 ? lines.join('\n') : '(none)',
            'Use these as scratch context. They are hidden from other participants.',
        ].join('\n');
        return [section('core.internal-history', text, 79, false, 'history')];
    },
};

const StimuliContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.stimuli',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const lines = ctx.context.stimuli.map(m => {
            const prefix = m.to === '*' ? `[${m.from}]` : `[${m.from} -> ${m.to}]`;
            return `${fmt(m.timestamp)} ${prefix}: ${m.text}`;
        });
        const empty = ctx.context.stimuli.length === 0
            ? '(none — heartbeat tick with no new messages)'
            : null;
        const text = [
            '## New messages since last check',
            empty ?? lines.join('\n'),
        ].join('\n');
        return [section('core.stimuli', text, 90, false, 'task')];
    },
};

const OwnRecentMessagesContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.own-messages',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        const own = [
            ...ctx.context.publicMessages.filter(m => m.from === ctx.handle),
            ...ctx.context.privateMessages.filter(m => m.from === ctx.handle),
        ].sort((a, b) => a.timestamp - b.timestamp);
        const lines = own.map(m =>
            m.to === '*'
                ? `${fmt(m.timestamp)} [you → room]: ${m.text}`
                : `${fmt(m.timestamp)} [you → ${m.to}]: ${m.text}`,
        );
        const text = [
            '## What you said recently',
            lines.length > 0 ? lines.join('\n') : '(nothing yet)',
        ].join('\n');
        return [section('core.own-messages', text, 88, true, 'task')];
    },
};

const MentionHintContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.mention-hint',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        if (!ctx.context.isMentioned) return [];
        const text = `You were mentioned by handle (${ctx.handle}) and should usually respond.`;
        return [section('core.mention-hint', text, 95, true, 'task')];
    },
};

const DmHintContributor: IPromptContributor<IvyPromptContext> = {
    id: 'core.dm-hint',
    contribute(ctx: IvyPromptContext): PromptSection[] {
        if (ctx.context.dmSenders.length === 0) return [];
        const text = [
            `You received private message(s) from ${ctx.context.dmSenders.join(', ')}.`,
            'When replying privately, use "dm": {"to": "<sender_handle>", "text": "<reply>"} so the response stays private.',
        ].join('\n');
        return [section('core.dm-hint', text, 94, true, 'task')];
    },
};

export class CorePromptPack implements IvyAgentPack {
    id = 'core-prompt';

    register(ctx: { promptRegistry: import('gears/agentic').IPromptContributorRegistry<IvyPromptContext> }): void {
        ctx.promptRegistry.register(IdentityContributor);
        ctx.promptRegistry.register(WakeContextContributor);
        ctx.promptRegistry.register(PublicHistoryContributor);
        ctx.promptRegistry.register(PrivateHistoryContributor);
        ctx.promptRegistry.register(InternalHistoryContributor);
        ctx.promptRegistry.register(StimuliContributor);
        ctx.promptRegistry.register(OwnRecentMessagesContributor);
        ctx.promptRegistry.register(MentionHintContributor);
        ctx.promptRegistry.register(DmHintContributor);
    }
}

function section(
    id: string,
    text: string,
    priority: number,
    sticky: boolean,
    phase: import('gears/agentic').PromptSectionPhase,
): PromptSection {
    return {
        id,
        priority,
        weight: 1,
        estimatedTokens: estimateTokens(text),
        tags: ['ivy', 'prompt'],
        sticky,
        phase,
        text: () => text,
    };
}

function fmt(ts: number): string {
    const d = new Date(ts);
    return `[${d.toISOString().slice(11, 19)}]`;
}
