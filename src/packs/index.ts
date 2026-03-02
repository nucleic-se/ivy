import type { IPromptContributorRegistry } from 'gears/agentic';
import { CorePromptPack } from './core-prompt.js';
import type { IvyAgentPack, IvyPromptContext } from './types.js';

const INTERNAL_PACKS: Record<string, () => IvyAgentPack> = {
    'core-prompt': () => new CorePromptPack(),
};

export function bootInternalPacks(
    packIds: string[],
    promptRegistry: IPromptContributorRegistry<IvyPromptContext>,
): void {
    for (const id of packIds) {
        const factory = INTERNAL_PACKS[id];
        if (!factory) {
            const available = Object.keys(INTERNAL_PACKS).join(', ');
            throw new Error(`Unknown internal agent pack "${id}". Available: ${available}`);
        }
        const pack = factory();
        pack.register({ promptRegistry });
    }
}

