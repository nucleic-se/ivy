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

/** Maximum number of sandbox tool calls an agent may include in a single response. */
export const MAX_CALLS_PER_TICK = 8;

/**
 * Consecutive LLM failures before the agent is considered degraded.
 * On reaching this threshold the onDegraded callback fires once and backoff
 * becomes exponential. The stimulus queue is preserved (capped, not drained).
 */
export const CONSECUTIVE_ERROR_THRESHOLD = 5;

/**
 * Maximum stimulus queue depth. When exceeded, the oldest entries are dropped
 * to keep memory bounded during a sustained LLM outage. Recent stimuli are
 * more relevant than old ones — recent messages are always preserved.
 */
export const MAX_QUEUE_SIZE = 50;

/** Maximum backoff delay (ms) between retries when the agent is degraded. */
export const MAX_ERROR_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum bytes for a single sandbox file read or write (512 KB). */
export const MAX_SANDBOX_FILE_BYTES = 512 * 1024;

/**
 * Maximum number of continuation rounds within a single wake.
 * A continuation fires immediately after tool results are posted as notes,
 * allowing the agent to act on them without sleeping until the next heartbeat.
 * Cap prevents infinite tool loops; 3 covers the common read→act→answer pattern.
 */
export const DEFAULT_MAX_CONTINUATIONS = 5;
