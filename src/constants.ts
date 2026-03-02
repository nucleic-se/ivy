import type { WakeMode } from './types.js';

export const DEFAULT_PROMPT_TOKEN_BUDGET = 64 * 1024;
export const DEFAULT_CONTEXT_WINDOW = 100;
export const DEFAULT_WAKE_MODE: WakeMode = 'all';
export const DEFAULT_HEARTBEAT_MS: number | null = null;

export const DEFAULT_AGENT_PACKS = ['core-prompt'] as const;
export const DEFAULT_PARTICIPANT_PACKS = ['routing-guard'] as const;
