import type { IvyParticipantPack, IvyRoutingGuard } from './types.js';
import { RoutingGuardPack } from './routing-guard.js';

const INTERNAL_PARTICIPANT_PACKS: Record<string, () => IvyParticipantPack> = {
    'routing-guard': () => new RoutingGuardPack(),
};

export function bootInternalParticipantPacks(
    packIds: string[],
    registerRoutingGuard: (guard: IvyRoutingGuard) => void,
): void {
    for (const id of packIds) {
        const factory = INTERNAL_PARTICIPANT_PACKS[id];
        if (!factory) {
            const available = Object.keys(INTERNAL_PARTICIPANT_PACKS).join(', ');
            throw new Error(`Unknown internal participant pack "${id}". Available: ${available}`);
        }
        const pack = factory();
        pack.register({ registerRoutingGuard });
    }
}

