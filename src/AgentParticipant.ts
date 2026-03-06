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

import type { ILogger, IStore } from '@nucleic-se/gears';
import type { Agent, AgentAction, AgentContext, CallAction, Message, Participant, WakeMode } from './types.js';
import type { Room } from './Room.js';
import type { IvyActionHandler, IvyParticipantPackContext, IvyRoutingGuard, RoutableAction } from './packs/types.js';
import type { Sandbox } from './sandbox/Sandbox.js';
import { bootInternalParticipantPacks } from './packs/participant.js';
import { SandboxParticipantPack } from './packs/sandbox-participant.js';
import {
    DEFAULT_PUBLIC_CONTEXT_WINDOW,
    DEFAULT_PRIVATE_CONTEXT_WINDOW,
    DEFAULT_INTERNAL_CONTEXT_WINDOW,
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_MAX_CONTINUATIONS,
    DEFAULT_PARTICIPANT_PACKS,
    DEFAULT_WAKE_MODE,
    CONSECUTIVE_ERROR_THRESHOLD,
    MAX_QUEUE_SIZE,
    MAX_ERROR_BACKOFF_MS,
} from './constants.js';

interface PersistedAgentConfig {
    wakeMode?: WakeMode;
    heartbeatMs?: number | null;
    publicContextWindow?: number;
    privateContextWindow?: number;
    internalContextWindow?: number;
}

export interface AgentParticipantConfig {
    /** Max recent public (broadcast) messages to include as context. Default: DEFAULT_PUBLIC_CONTEXT_WINDOW */
    publicContextWindow?: number;
    /** Max recent private DMs to include as context. Default: DEFAULT_PRIVATE_CONTEXT_WINDOW */
    privateContextWindow?: number;
    /** Max recent internal notes/tool results to include as context. Default: DEFAULT_INTERNAL_CONTEXT_WINDOW */
    internalContextWindow?: number;
    /** Initial wake-on-message setting. Default from src/constants.ts */
    wakeMode?: WakeMode;
    /** Initial heartbeat interval in ms. null = disabled. Default from src/constants.ts */
    heartbeatMs?: number | null;
    /** Internal participant packs only (self-contained). */
    packs?: string[];
    /** Sandbox to expose to the agent via fs/call action handlers. */
    sandbox?: Sandbox;
    /**
     * Maximum number of immediate continuation rounds after tool results are posted.
     * A continuation lets the agent act on tool results within the same wake, without
     * waiting for the next heartbeat or external message.
     * Default: DEFAULT_MAX_CONTINUATIONS (3).
     */
    maxContinuations?: number;
    /**
     * IStore for persisting runtime config (wakeMode, heartbeatMs, context windows) across restarts.
     * Gracefully absent: config becomes ephemeral (no change to in-process behaviour).
     * Explicit constructor config always overrides any persisted value.
     */
    store?: IStore;
    /**
     * Called when the agent hits CONSECUTIVE_ERROR_THRESHOLD consecutive LLM failures.
     * The pending stimulus queue is cleared before this fires (stale after repeated failures).
     * Use to emit an alert (e.g. Slack notification). The agent continues running and will
     * recover automatically once the LLM provider starts responding again.
     */
    onDegraded?: (handle: string) => void;
}

export class AgentParticipant implements Participant {
    readonly handle: string;
    readonly displayName: string;

    private agent: Agent;
    private room: Room;
    private logger?: ILogger;
    private publicContextWindow: number;
    private privateContextWindow: number;
    private internalContextWindow: number;
    private routingGuards: IvyRoutingGuard[] = [];
    private actionHandlers: Map<string, IvyActionHandler> = new Map();

    // Wake / attention settings (agent-configurable at runtime)
    private wakeMode: WakeMode;
    private heartbeatMs: number | null;
    private readonly maxContinuations: number;

    // Config persistence
    private readonly store: IStore | null;
    private readonly storeKey: string;
    /** Tracks which config fields were explicitly set in the constructor (these override persisted values). */
    private readonly explicitConfig: Pick<AgentParticipantConfig,
        'wakeMode' | 'heartbeatMs' | 'publicContextWindow' | 'privateContextWindow' | 'internalContextWindow'
    >;
    private configLoaded = false;

    // Degradation tracking
    private consecutiveErrors = 0;
    private degraded = false;
    private readonly onDegraded: ((handle: string) => void) | null;

    // Stimulus queue + wake signal
    private queue: Message[] = [];
    private wakeRequested = false;
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
        this.publicContextWindow   = config?.publicContextWindow   ?? DEFAULT_PUBLIC_CONTEXT_WINDOW;
        this.privateContextWindow  = config?.privateContextWindow  ?? DEFAULT_PRIVATE_CONTEXT_WINDOW;
        this.internalContextWindow = config?.internalContextWindow ?? DEFAULT_INTERNAL_CONTEXT_WINDOW;
        this.wakeMode = config?.wakeMode ?? DEFAULT_WAKE_MODE;
        this.heartbeatMs = config?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        this.maxContinuations = config?.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
        this.store = config?.store ?? null;
        this.onDegraded = config?.onDegraded ?? null;
        this.storeKey = `ivy:agent:${this.handle}:config`;
        this.explicitConfig = {
            wakeMode: config?.wakeMode,
            heartbeatMs: config?.heartbeatMs,
            publicContextWindow: config?.publicContextWindow,
            privateContextWindow: config?.privateContextWindow,
            internalContextWindow: config?.internalContextWindow,
        };
        this.logger = logger;
        const packCtx: IvyParticipantPackContext = {
            registerRoutingGuard: (guard) => { this.routingGuards.push(guard); },
            registerActionHandler: (handler) => { this.actionHandlers.set(handler.type, handler); },
        };
        bootInternalParticipantPacks(config?.packs ?? [...DEFAULT_PARTICIPANT_PACKS], packCtx);
        if (config?.sandbox) {
            new SandboxParticipantPack(config.sandbox).register(packCtx);
        }
    }

    /**
     * Non-blocking: enqueues stimulus and, if the message qualifies under the
     * current wake mode, signals the processing loop to wake immediately.
     */
    receive(message: Message): void {
        this.queue.push(message);
        const qualifies = this.qualifiesForWake(message);
        this.logger?.debug(`${this.displayName} received message`, {
            from: message.from, type: message.to ? 'dm' : 'room', wakes: qualifies,
        });
        if (qualifies) {
            this.wakeRequested = true;
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

    /**
     * Inject a text observation as an internal note and wake the agent if it is sleeping.
     * Used by ScheduleToolPack (and similar) to deliver reminder fire events.
     */
    observe(text: string): void {
        this.room.note(this.handle, text);
        this.wakeRequested = true;
        this.wake();
    }

    /** Stop the processing loop and cancel any pending heartbeat. */
    stop(): void {
        this.running = false;
        this.runVersion++;
        this.wakeRequested = false;
        this.clearHeartbeatTimer();
        if (this.wakeResolve) {
            this.wakeResolve();
            this.wakeResolve = null;
        }
    }

    // ─── Internal loop ──────────────────────────────────────────

    private async loop(): Promise<void> {
        while (this.running) {
            // Load persisted config before first sleep so restored heartbeat/wake
            // settings apply immediately after process start.
            if (!this.configLoaded) {
                this.configLoaded = true;
                await this.loadPersistedConfig();
                if (!this.running) break;
            }

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
            this.logger?.debug(`${this.displayName} woke`, {
                stimuli: stimuli.length, trigger: stimuli.length > 0 ? 'message' : 'heartbeat',
            });
            try {
                await this.process(stimuli);
                this.consecutiveErrors = 0;
                this.degraded = false;
            } catch (err) {
                const msg = (err as Error).message;
                this.logger?.error(`${this.displayName} think error`, {
                    error: msg,
                    stack: (err as Error).stack?.split('\n').slice(0, 4).join(' | '),
                });

                // Re-queue stimuli so they are not lost on LLM errors.
                if (stimuli.length > 0) {
                    this.queue.unshift(...stimuli);
                }

                // Cap the queue to prevent unbounded growth during sustained outages.
                // Drop oldest entries — recent stimuli are more relevant on recovery.
                if (this.queue.length > MAX_QUEUE_SIZE) {
                    const dropped = this.queue.length - MAX_QUEUE_SIZE;
                    this.queue = this.queue.slice(dropped);
                    this.logger?.warn(`${this.displayName} queue capped — dropped ${dropped} oldest stimulus/stimuli`);
                }

                this.consecutiveErrors++;
                this.logger?.warn(`${this.displayName} re-queued stimuli after think error (${this.consecutiveErrors}/${CONSECUTIVE_ERROR_THRESHOLD})`, { queued: this.queue.length });

                // On reaching the threshold: notify once, then use exponential backoff.
                if (this.consecutiveErrors === CONSECUTIVE_ERROR_THRESHOLD) {
                    this.degraded = true;
                    this.onDegraded?.(this.handle);
                }

                // Backoff: flat 10s for transient errors; exponential (capped) when degraded.
                const backoffMs = this.degraded
                    ? Math.min(10_000 * Math.pow(2, this.consecutiveErrors - CONSECUTIVE_ERROR_THRESHOLD), MAX_ERROR_BACKOFF_MS)
                    : 10_000;
                await new Promise<void>(r => setTimeout(r, backoffMs));
                if (!this.running) break;
            }
        }
    }

    /**
     * Load persisted runtime config from IStore on first start.
     * Skips any field that was explicitly provided in the constructor config.
     */
    private async loadPersistedConfig(): Promise<void> {
        if (!this.store) return;
        let saved: PersistedAgentConfig | null;
        try { saved = await this.store.get<PersistedAgentConfig>(this.storeKey); }
        catch { return; }
        if (!saved) return;
        if (saved.wakeMode !== undefined && this.explicitConfig.wakeMode === undefined)
            this.wakeMode = saved.wakeMode;
        if (saved.heartbeatMs !== undefined && this.explicitConfig.heartbeatMs === undefined)
            this.heartbeatMs = saved.heartbeatMs;
        if (saved.publicContextWindow !== undefined && this.explicitConfig.publicContextWindow === undefined)
            this.publicContextWindow = Math.max(5, saved.publicContextWindow);
        if (saved.privateContextWindow !== undefined && this.explicitConfig.privateContextWindow === undefined)
            this.privateContextWindow = Math.max(3, saved.privateContextWindow);
        if (saved.internalContextWindow !== undefined && this.explicitConfig.internalContextWindow === undefined)
            this.internalContextWindow = Math.max(3, saved.internalContextWindow);
    }

    /** Snapshot current runtime config to IStore (fire-and-forget). */
    private persistConfig(): void {
        if (!this.store) return;
        const snapshot: PersistedAgentConfig = {
            wakeMode: this.wakeMode,
            heartbeatMs: this.heartbeatMs,
            publicContextWindow: this.publicContextWindow,
            privateContextWindow: this.privateContextWindow,
            internalContextWindow: this.internalContextWindow,
        };
        this.store.set(this.storeKey, snapshot).catch(() => {
            this.logger?.warn(`${this.displayName} failed to persist agent config`);
        });
    }

    /**
     * Returns a promise that resolves when the agent should next think.
     *
     * - If a wake was requested while not sleeping, resolves immediately.
     * - Otherwise blocks until wake() is called (by receive()/observe()) or the
     *   heartbeat timer fires.
     */
    private waitForWake(): Promise<void> {
        if (this.wakeRequested) {
            this.wakeRequested = false;
            return Promise.resolve();
        }
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
            this.wakeRequested = false;
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
        let continuations = 0;
        let currentStimuli = stimuli;

        while (true) {
            const context = this.assembleContext(currentStimuli);
            this.logger?.info(`${this.displayName} thinking`, {
                stimuli: currentStimuli.length,
                wakeMode: this.wakeMode,
                ...(continuations > 0 && { continuation: continuations }),
            });
            const actions = await this.agent.think(context);
            this.logger?.info(`${this.displayName} think done`, {
                actions: actions.length,
                types: actions.map(a => a.type),
            });

            // Hard-stop guarantee: do not emit messages after stop()/restart boundaries.
            if (!this.running || this.runVersion !== versionAtStart) return;

            // Configure: apply state changes immediately (order-preserving).
            let configured = false;
            for (const action of actions) {
                if (action.type === 'configure') {
                    configured = true;
                    if (action.wakeOn !== undefined) this.wakeMode = action.wakeOn;
                    if (action.heartbeatMs !== undefined) this.heartbeatMs = action.heartbeatMs;
                    if (action.publicContextWindow !== undefined)
                        this.publicContextWindow = Math.max(5, Math.floor(action.publicContextWindow));
                    if (action.privateContextWindow !== undefined)
                        this.privateContextWindow = Math.max(3, Math.floor(action.privateContextWindow));
                    if (action.internalContextWindow !== undefined)
                        this.internalContextWindow = Math.max(3, Math.floor(action.internalContextWindow));
                }
            }
            if (configured) this.persistConfig();

            // Note: write private self-notes directly (bypass routing guards).
            for (const action of actions) {
                if (action.type === 'note') {
                    this.room.note(this.handle, action.text);
                }
            }

            // Fs: dispatch to registered action handler; post result as an internal note.
            let hadToolActions = false;
            for (const action of actions) {
                if (action.type !== 'fs') continue;
                hadToolActions = true;
                const handler = this.actionHandlers.get('fs');
                if (!handler) {
                    this.logger?.warn(`${this.displayName} has no handler for action type "fs"`);
                    continue;
                }
                let result: string;
                try {
                    result = await handler.handle(action, this.handle);
                } catch (err) {
                    result = `Error: ${(err as Error).message}`;
                    this.logger?.warn(`${this.displayName} fs action handler error`, { error: (err as Error).message });
                }
                if (!this.running || this.runVersion !== versionAtStart) return;
                this.room.note(this.handle, result!);
            }

            // Call: execute batch, collect all results, post as a single note.
            // On first failure, remaining calls are skipped (batch-abort). All
            // results — including the abort notice — appear in the same note so
            // the agent receives a single coherent summary rather than N fragments.
            const callActions = actions.filter((a): a is CallAction => a.type === 'call');
            if (callActions.length > 0) {
                hadToolActions = true;
                const handler = this.actionHandlers.get('call');
                interface CallEntry { tool: string; result: string; failed: boolean }
                const entries: CallEntry[] = [];
                let abortedAt = -1;

                for (let i = 0; i < callActions.length; i++) {
                    const action = callActions[i]!;
                    if (!handler) {
                        this.logger?.warn(`${this.displayName} has no handler for action type "call"`);
                        break;
                    }
                    let result: string;
                    let failed = false;
                    try {
                        result = await handler.handle(action, this.handle);
                    } catch (err) {
                        result = `Error: ${(err as Error).message}`;
                        failed = true;
                        this.logger?.warn(`${this.displayName} call action handler error`, { tool: action.tool, error: (err as Error).message });
                    }
                    if (!this.running || this.runVersion !== versionAtStart) return;
                    entries.push({ tool: action.tool, result: result!, failed });
                    if (failed) { abortedAt = i; break; }
                }

                // Build the combined note.
                const lines: string[] = [`[calls: ${callActions.length} op${callActions.length !== 1 ? 's' : ''}]`];
                for (const e of entries) {
                    lines.push(`${e.failed ? '✗' : '✓'} ${e.tool} → ${e.result}`);
                }
                if (abortedAt >= 0) {
                    const skipped = callActions.length - abortedAt - 1;
                    if (skipped > 0) {
                        lines.push(`[batch] ${skipped} remaining call(s) skipped after error in \`${callActions[abortedAt]!.tool}\`. Re-read state before retrying.`);
                    }
                }
                this.room.note(this.handle, lines.join('\n'));
            }

            // Speak / DM: pass through routing guards before dispatch.
            const routableActions = actions.filter(
                (a): a is RoutableAction => a.type === 'speak' || a.type === 'dm',
            );
            if (routableActions.length > 0) {
                const approved = await this.applyRoutingGuards(routableActions);

                // Check again — stop() may have been called during think or guards.
                if (!this.running || this.runVersion !== versionAtStart) return;

                for (const action of approved) {
                    this.dispatchAction(action);
                }
            }

            // Continuation: if tool results were posted this iteration and we haven't hit
            // the cap, loop immediately so the agent can act on the results without sleeping.
            // On continuation ticks, stimuli are empty — the tool results appear in
            // internalMessages where the agent can see them.
            if (!hadToolActions || continuations >= this.maxContinuations) break;
            continuations++;
            currentStimuli = [];
        }
    }

    /** Assemble context from Room history + current stimuli. */
    private assembleContext(stimuli: Message[]): AgentContext {
        // Stimuli are already persisted in the log by the time we get here, so exclude
        // them from history to avoid showing the same message in both sections.
        const stimulusIds = new Set(stimuli.map(m => m.id));
        const publicMessages = this.room.getPublic(this.publicContextWindow)
            .filter(m => !stimulusIds.has(m.id));
        const privateMessages = this.room.getPrivate(this.handle, this.privateContextWindow)
            .filter(m => !stimulusIds.has(m.id));
        const internalMessages = this.room.getInternal(this.handle, this.internalContextWindow)
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
            publicContextWindow: this.publicContextWindow,
            privateContextWindow: this.privateContextWindow,
            internalContextWindow: this.internalContextWindow,
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
