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
    /** Current max public messages in context. */
    publicContextWindow: number;
    /** Current max private messages in context. */
    privateContextWindow: number;
    /** Current max internal notes in context. */
    internalContextWindow: number;
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
/**
 * Semantic alias for a DM used when handing off work to another agent.
 * Routed identically to DmAction (via room.dm()), but signals coordinator intent.
 */
export interface CoordinateAction { type: 'coordinate'; to: string; text: string }
/** Write a private self-note, visible only in the agent's own internal history. */
export interface NoteAction     { type: 'note'; text: string }
/**
 * Adjust the agent's own attention settings.
 *
 * `wakeOn`      — change which incoming messages trigger an immediate wake.
 * `heartbeatMs` — set a recurring timer (null disables it).
 * `publicContextWindow`   — max public messages in context (min 5).
 * `privateContextWindow`  — max private DMs in context (min 3).
 * `internalContextWindow` — max internal notes in context (min 3).
 */
export interface ConfigureAction {
    type: 'configure';
    wakeOn?: WakeMode;
    heartbeatMs?: number | null;
    publicContextWindow?: number;
    privateContextWindow?: number;
    internalContextWindow?: number;
}

export type FsOp = 'read' | 'write' | 'ls' | 'mkdir' | 'rm' | 'stat' | 'mv';

/** Perform a filesystem operation inside the agent sandbox. */
export interface FsAction {
    type: 'fs';
    op: FsOp;
    /** Absolute path from sandbox root, e.g. "/home/notes.md". */
    path: string;
    /** Content for write operations. */
    content?: string;
    /** Destination path for mv operations. */
    dest?: string;
    /** For rm: delete non-empty directories recursively. */
    recursive?: boolean;
}

/** Invoke a named tool registered in the sandbox tool registry. */
export interface CallAction {
    type: 'call';
    tool: string;
    args?: Record<string, unknown>;
}

export type AgentAction = SpeakAction | DmAction | CoordinateAction | NoteAction | ConfigureAction | FsAction | CallAction;

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
