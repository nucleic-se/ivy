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

/**
 * Maximum number of continuation rounds within a single wake.
 * A continuation fires immediately after tool results are posted as notes,
 * allowing the agent to act on them without sleeping until the next heartbeat.
 * Cap prevents infinite tool loops; 3 covers the common read→act→answer pattern.
 */
export const DEFAULT_MAX_CONTINUATIONS = 3;
