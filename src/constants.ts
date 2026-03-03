import type { WakeMode } from './types.js';

export const DEFAULT_PROMPT_TOKEN_BUDGET = 64 * 1024;

/** Recent public (broadcast) messages shown in every prompt. */
export const DEFAULT_PUBLIC_CONTEXT_WINDOW = 25;
/** Recent private DMs (sent or received) shown in every prompt. */
export const DEFAULT_PRIVATE_CONTEXT_WINDOW = 20;
/** Recent internal notes + tool results shown in every prompt. */
export const DEFAULT_INTERNAL_CONTEXT_WINDOW = 15;

export const DEFAULT_WAKE_MODE: WakeMode = 'all';
export const DEFAULT_HEARTBEAT_MS: number | null = null;

export const DEFAULT_AGENT_PACKS = ['core-prompt'] as const;
export const DEFAULT_PARTICIPANT_PACKS = ['routing-guard'] as const;
