import type { IvyParticipantPack, IvyRoutingGuard, IvyRoutingGuardContext, IvyRoutingGuardResult, RoutableAction } from './types.js';

const HANDLE_PATTERN = /@[\w]+/g;
const SYSTEM_NOTICE_PREFIXES = [
    'Cannot send private message to ',
    'Unknown handle mention(s): ',
];

class UnknownHandleRoutingGuard implements IvyRoutingGuard {
    id = 'routing.unknown-handle';

    inspect(ctx: IvyRoutingGuardContext): IvyRoutingGuardResult {
        const knownHandles = new Set(ctx.room.getParticipants().map(p => p.handle));
        const extraMessages: RoutableAction[] = [];

        let action: RoutableAction | null = ctx.action;

        // Invalid DM target: drop original action to avoid leaking private content.
        if (action.type === 'dm' && !knownHandles.has(action.to)) {
            const available = [...knownHandles].join(', ') || '(none)';
            extraMessages.push({
                type: 'speak',
                text: `Cannot send private message to ${action.to} because that handle does not exist. Available handles: ${available}.`,
            });
            action = null;
        }

        if (!action) {
            return { action: null, extraMessages };
        }

        if (!isSystemNotice(action.text)) {
            const mentions = extractHandles(action.text);
            const unknownMentions = [...new Set(mentions.filter(h => !knownHandles.has(h)))];
            if (unknownMentions.length > 0) {
                const available = [...knownHandles].join(', ') || '(none)';
                extraMessages.push({
                    type: 'speak',
                    text: `Unknown handle mention(s): ${unknownMentions.join(', ')}. Available handles: ${available}.`,
                });
            }
        }

        return { action, extraMessages };
    }
}

export class RoutingGuardPack implements IvyParticipantPack {
    id = 'routing-guard';

    register(ctx: { registerRoutingGuard: (guard: IvyRoutingGuard) => void }): void {
        ctx.registerRoutingGuard(new UnknownHandleRoutingGuard());
    }
}

function extractHandles(text: string): string[] {
    return text.match(HANDLE_PATTERN) ?? [];
}

function isSystemNotice(text: string): boolean {
    return SYSTEM_NOTICE_PREFIXES.some(prefix => text.startsWith(prefix));
}
