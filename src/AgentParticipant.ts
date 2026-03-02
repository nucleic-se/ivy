/**
 * AgentParticipant — adapts any Agent into a Room Participant.
 *
 * Owns the stimulus queue, sleep/wake loop, context assembly from
 * the Room, and response routing. The Agent only sees assembled
 * context and returns a decision.
 *
 * Wake modes:
 *  - 'all'      — wake immediately on any visible message (default)
 *  - 'mentions' — wake only when @mentioned or when a DM arrives
 *  - 'dm'       — wake only on direct messages
 *  - 'none'     — never wake on messages; rely on heartbeat only
 *
 * Messages are always queued (for context on next wake), but only
 * qualifying messages trigger an immediate wake signal.
 */

import type { ILogger } from 'gears';
import type { Agent, AgentAction, AgentContext, Message, Participant, WakeMode } from './types.js';
import type { Room } from './Room.js';
import type { IvyRoutingGuard, RoutableAction } from './packs/types.js';
import { bootInternalParticipantPacks } from './packs/participant.js';
import {
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_PARTICIPANT_PACKS,
    DEFAULT_WAKE_MODE,
} from './constants.js';

export interface AgentParticipantConfig {
    /** Max recent public messages to include as context. Default from src/constants.ts */
    contextWindow?: number;
    /** Initial wake-on-message setting. Default from src/constants.ts */
    wakeMode?: WakeMode;
    /** Initial heartbeat interval in ms. null = disabled. Default from src/constants.ts */
    heartbeatMs?: number | null;
    /** Internal participant packs only (self-contained). */
    packs?: string[];
}

export class AgentParticipant implements Participant {
    readonly handle: string;
    readonly displayName: string;

    private agent: Agent;
    private room: Room;
    private logger?: ILogger;
    private contextWindow: number;
    private routingGuards: IvyRoutingGuard[] = [];

    // Wake / attention settings (agent-configurable at runtime)
    private wakeMode: WakeMode;
    private heartbeatMs: number | null;

    // Stimulus queue + wake signal
    private queue: Message[] = [];
    private wakeResolve: (() => void) | null = null;
    private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    /** Incremented on each start/stop to invalidate in-flight think/send work. */
    private runVersion = 0;

    constructor(agent: Agent, room: Room, config?: AgentParticipantConfig, logger?: ILogger) {
        this.agent = agent;
        this.handle = agent.handle;
        this.displayName = agent.displayName;
        this.room = room;
        this.contextWindow = config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        this.wakeMode = config?.wakeMode ?? DEFAULT_WAKE_MODE;
        this.heartbeatMs = config?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        this.logger = logger;
        bootInternalParticipantPacks(
            config?.packs ?? [...DEFAULT_PARTICIPANT_PACKS],
            (guard) => { this.routingGuards.push(guard); },
        );
    }

    /**
     * Non-blocking: enqueues stimulus and, if the message qualifies under the
     * current wake mode, signals the processing loop to wake immediately.
     */
    receive(message: Message): void {
        this.queue.push(message);
        if (this.qualifiesForWake(message)) {
            this.wake();
        }
    }

    /** Start the async processing loop. Idempotent. */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.runVersion++;
        this.loop().catch(err => {
            this.logger?.error(`${this.displayName} loop crashed`, { error: (err as Error).message });
        });
    }

    /** Stop the processing loop and cancel any pending heartbeat. */
    stop(): void {
        this.running = false;
        this.runVersion++;
        this.clearHeartbeatTimer();
        if (this.wakeResolve) {
            this.wakeResolve();
            this.wakeResolve = null;
        }
    }

    // ─── Internal loop ──────────────────────────────────────────

    private async loop(): Promise<void> {
        while (this.running) {
            // The heartbeat timer is only ever active while we are sleeping here —
            // it is cancelled the moment we wake. Because process() must complete
            // before we call waitForWake() again, heartbeat ticks can never overlap
            // with in-flight LLM calls: the agent simply runs at the pace of its
            // slowest think() call, which is exactly the desired "go as fast as
            // you can" behaviour when the LLM is slower than the heartbeat interval.
            await this.waitForWake();
            if (!this.running) break;

            // Stimuli may be empty on a pure heartbeat tick — agent sees the empty list.
            const stimuli = this.queue.splice(0);
            try {
                await this.process(stimuli);
            } catch (err) {
                this.logger?.error(`${this.displayName} think error`, { error: (err as Error).message });
            }
        }
    }

    /**
     * Returns a promise that resolves when the agent should next think.
     *
     * - If the queue is already non-empty (e.g. messages arrived before start(),
     *   or during a previous process() call), resolves immediately so they are
     *   drained without any sleeping — this also avoids the wakeResolve race.
     * - Otherwise blocks until wake() is called (by receive()) or the heartbeat
     *   timer fires.
     */
    private waitForWake(): Promise<void> {
        if (this.queue.length > 0) return Promise.resolve();
        return new Promise<void>(resolve => {
            this.wakeResolve = resolve;
            if (this.heartbeatMs !== null) {
                this.heartbeatTimer = setTimeout(() => {
                    this.wakeResolve = null;
                    this.heartbeatTimer = undefined;
                    resolve();
                }, this.heartbeatMs);
            }
        });
    }

    /** Immediately resolve the current waitForWake promise. */
    private wake(): void {
        if (this.wakeResolve) {
            this.clearHeartbeatTimer();
            this.wakeResolve();
            this.wakeResolve = null;
        }
    }

    private clearHeartbeatTimer(): void {
        if (this.heartbeatTimer !== undefined) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    /** Whether a message should trigger an immediate wake under the current mode. */
    private qualifiesForWake(message: Message): boolean {
        switch (this.wakeMode) {
            case 'all':  return true;
            case 'none': return false;
            case 'dm':   return message.to === this.handle;
            case 'mentions': {
                if (message.to === this.handle) return true;
                const mentionPattern = new RegExp(`(^|\\s)${escapeRegExp(this.handle)}(\\b|\\s|$)`);
                return mentionPattern.test(message.text);
            }
        }
    }

    private async process(stimuli: Message[]): Promise<void> {
        const versionAtStart = this.runVersion;
        const context = this.assembleContext(stimuli);
        const actions = await this.agent.think(context);

        // Hard-stop guarantee: do not emit messages after stop()/restart boundaries.
        if (!this.running || this.runVersion !== versionAtStart) return;

        // Configure: apply state changes immediately (order-preserving).
        for (const action of actions) {
            if (action.type === 'configure') {
                if (action.wakeOn !== undefined) this.wakeMode = action.wakeOn;
                if (action.heartbeatMs !== undefined) this.heartbeatMs = action.heartbeatMs;
            }
        }

        // Note: write private self-notes directly (bypass routing guards).
        for (const action of actions) {
            if (action.type === 'note') {
                this.room.note(this.handle, action.text);
            }
        }

        // Speak / DM: pass through routing guards before dispatch.
        const routableActions = actions.filter(
            (a): a is RoutableAction => a.type === 'speak' || a.type === 'dm',
        );
        if (routableActions.length === 0) return;

        const approved = await this.applyRoutingGuards(routableActions);

        // Check again — stop() may have been called during think or guards.
        if (!this.running || this.runVersion !== versionAtStart) return;

        for (const action of approved) {
            this.dispatchAction(action);
        }
    }

    /** Assemble context from Room history + current stimuli. */
    private assembleContext(stimuli: Message[]): AgentContext {
        // Stimuli are already persisted in the log by the time we get here, so exclude
        // them from history to avoid showing the same message in both sections.
        const stimulusIds = new Set(stimuli.map(m => m.id));
        const publicMessages = this.room.getPublic(this.contextWindow)
            .filter(m => !stimulusIds.has(m.id));
        const privateMessages = this.room.getPrivate(this.handle, Math.floor(this.contextWindow / 2))
            .filter(m => !stimulusIds.has(m.id));
        const internalMessages = this.room.getInternal(this.handle, Math.floor(this.contextWindow / 2))
            .filter(m => !stimulusIds.has(m.id));

        const mentionPattern = new RegExp(`(^|\\s)${escapeRegExp(this.handle)}(\\b|\\s|$)`);
        const isMentioned = stimuli.some(m => mentionPattern.test(m.text));
        const dmSenders = [...new Set(
            stimuli.filter(m => m.to === this.handle).map(m => m.from),
        )];

        return {
            publicMessages,
            privateMessages,
            internalMessages,
            stimuli,
            isMentioned,
            dmSenders,
            wakeMode: this.wakeMode,
            heartbeatMs: this.heartbeatMs,
        };
    }

    private dispatchAction(action: RoutableAction): void {
        if (action.type === 'dm') {
            this.room.dm(this.handle, action.to, action.text);
        } else {
            this.room.post(this.handle, action.text);
        }
    }

    private async applyRoutingGuards(actions: RoutableAction[]): Promise<RoutableAction[]> {
        const pending: RoutableAction[] = [...actions];
        const accepted: RoutableAction[] = [];
        let processed = 0;
        const maxMessages = 20; // Prevent accidental infinite guard loops.

        while (pending.length > 0 && processed < maxMessages) {
            processed++;
            let current: RoutableAction | null = pending.shift() ?? null;
            if (!current) continue;

            for (const guard of this.routingGuards) {
                const result = await guard.inspect({
                    senderHandle: this.handle,
                    senderDisplayName: this.displayName,
                    action: current,
                    room: this.room,
                });
                current = result.action;
                if (result.extraMessages?.length) {
                    pending.push(...result.extraMessages);
                }
                if (!current) break;
            }

            if (current) {
                accepted.push(current);
            }
        }

        if (processed >= maxMessages) {
            this.logger?.warn(`${this.displayName} routing guards produced too many messages; truncating`, {
                maxMessages,
            });
        }

        return accepted;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
