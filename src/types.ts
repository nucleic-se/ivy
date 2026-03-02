/**
 * Core types for the Ivy chatroom.
 */

export interface Message {
    id: string;
    from: string;
    /** Target: '*' for broadcast, a handle for DM, or from===to for an internal self-note. */
    to: string;
    text: string;
    timestamp: number;
}

export interface Participant {
    handle: string;
    displayName: string;
    /** Called by the Room when a new message is posted that this participant can see. Must be non-blocking. */
    receive(message: Message): void;
}

// ─── Agent (cognitive core) ─────────────────────────────────────

/**
 * When to wake the agent loop on an incoming room message.
 *
 * - 'all'      — wake on any visible message (default)
 * - 'mentions' — wake only when @mentioned or when a DM arrives
 * - 'dm'       — wake only on direct messages
 * - 'none'     — never wake on messages; rely on heartbeat only
 */
export type WakeMode = 'all' | 'mentions' | 'dm' | 'none';

/** Context assembled by the adapter and handed to the agent for decision-making. */
export interface AgentContext {
    /** Recent public chatroom messages (chronological, current stimuli excluded). */
    publicMessages: Message[];
    /** Recent private messages involving this agent (chronological, current stimuli excluded). */
    privateMessages: Message[];
    /** Recent internal self-notes for this agent (chronological, current stimuli excluded). */
    internalMessages: Message[];
    /** New stimuli since last wake (may be empty on a heartbeat tick). */
    stimuli: Message[];
    /** Whether the agent was @-mentioned in any stimulus. */
    isMentioned: boolean;
    /** Handles of people who sent DMs to this agent in the current batch. */
    dmSenders: string[];
    /** Current wake-on-message setting. */
    wakeMode: WakeMode;
    /** Current heartbeat interval in ms, or null if disabled. */
    heartbeatMs: number | null;
}

// ─── Agent actions ───────────────────────────────────────────────
//
// think() returns at most one of each action type per cycle.
// Single outputs per tick are enforced by the LLM schema — this
// is the structural guard against multi-step repetition.

/** Broadcast a public message to the chatroom. */
export interface SpeakAction    { type: 'speak'; text: string }
/** Send a private message to a specific participant. */
export interface DmAction       { type: 'dm'; to: string; text: string }
/** Write a private self-note, visible only in the agent's own internal history. */
export interface NoteAction     { type: 'note'; text: string }
/**
 * Adjust the agent's own attention settings.
 *
 * `wakeOn`      — change which incoming messages trigger an immediate wake.
 * `heartbeatMs` — set a recurring timer (null disables it).
 */
export interface ConfigureAction {
    type: 'configure';
    wakeOn?: WakeMode;
    heartbeatMs?: number | null;
}

export type AgentAction = SpeakAction | DmAction | NoteAction | ConfigureAction;

/**
 * Agent — pure cognitive interface.
 *
 * Knows nothing about the Room, queues, or transport. Receives assembled
 * context and returns a (possibly empty) list of actions to perform.
 * At most one speak, one dm, one note, and one configure per call.
 */
export interface Agent {
    handle: string;
    displayName: string;
    think(context: AgentContext): Promise<AgentAction[]>;
}

/** Check whether a participant can see a message. */
export function isVisibleTo(msg: Message, handle: string): boolean {
    return msg.to === '*' || msg.to === handle || msg.from === handle;
}
