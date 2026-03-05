/**
 * ScheduleToolPack — per-agent reminder scheduling.
 *
 * Mounts a single /tools/schedule/ group in the shared sandbox. Tool handlers
 * are routed by callerHandle so each agent manages its own isolated reminder set.
 *
 * Tools:
 *   schedule/set    — schedule a recurring (cron) or one-off (ISO datetime) reminder
 *   schedule/list   — list this agent's active reminders
 *   schedule/cancel — cancel a reminder by id
 *
 * When a reminder fires it is delivered as an internal note (via observe()) which
 * also wakes the agent immediately if it is sleeping.
 *
 * Persistence:
 *   Cron:  IScheduler (runtime) + IStore (persist across restarts). On boot(),
 *          stored reminders are re-registered with IScheduler automatically.
 *   Once:  setTimeout (runtime) + IStore (listed and re-armed on boot()).
 *          Degrades to ephemeral setTimeout when IStore is unavailable.
 *
 * Graceful degradation:
 *   IScheduler absent → schedule/set(cron) returns an error; list/cancel still work.
 *   IStore absent     → reminders are ephemeral (lost on restart); still functional in-process.
 */

import type { IScheduler, IStore } from '@nucleic-se/gears';
import type { SandboxLayer } from '../sandbox/layer.js';
import { ToolGroupPack } from '../sandbox/ToolGroupPack.js';
import type { Tool } from '../sandbox/ToolGroupPack.js';

// ─── Types ───────────────────────────────────────────────────────

interface AgentState {
    handle: string;
    scheduler: IScheduler | null;
    store: IStore | null;
    observeFn: ((text: string) => void) | null;
    onceTimers: Map<string, ReturnType<typeof setTimeout>>;
    cronReminders: Map<string, StoredCronReminder>;
}

interface StoredCronReminder {
    id: string;
    message: string;
    cron: string;
    createdAt: number;
}

interface StoredOnceReminder {
    id: string;
    message: string;
    firesAt: number;
    createdAt: number;
}

export interface ScheduleReminderView {
    owner: string;
    id: string;
    type: 'cron' | 'once';
    schedule: string;
    message: string;
    persisted: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** IScheduler job name for a per-agent cron reminder. */
function cronJobName(handle: string, id: string): string {
    return `ivy:schedule:${handle}:${id}`;
}

/** Minimal 5-field cron validation. */
function isValidCron(expr: string): boolean {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    return parts.every(p => /^[\d*/\-,]+$/.test(p));
}

// ─── Pack ────────────────────────────────────────────────────────

export class ScheduleToolPack {
    private readonly agentStates = new Map<string, AgentState>();

    /**
     * Register an agent so it can use the schedule tools.
     * Call once per agent before boot(). Handle may include or omit the @ prefix.
     */
    registerAgent(handle: string, options: {
        scheduler?: IScheduler | null;
        store?: IStore | null;
    }): void {
        const h = handle.replace(/^@/, '');
        this.agentStates.set(h, {
            handle: h,
            scheduler: options.scheduler ?? null,
            store: options.store ?? null,
            observeFn: null,
            onceTimers: new Map(),
            cronReminders: new Map(),
        });
    }

    /**
     * Bind the observe callback for an agent.
     * Must be called after the AgentParticipant is created so the participant's
     * observe() method is available. Late-binding is safe because boot() is
     * called after this.
     */
    setObserve(handle: string, fn: (text: string) => void): void {
        const state = this.agentStates.get(handle.replace(/^@/, ''));
        if (state) state.observeFn = fn;
    }

    /**
     * Restore persisted reminders after all agents are registered.
     * Async — returns when all agents have had their reminders re-armed.
     */
    async boot(): Promise<void> {
        await Promise.all([...this.agentStates.values()].map(s => this._bootAgent(s)));
    }

    /** Create the /tools/schedule/ layer to mount in the sandbox. */
    createLayer(): SandboxLayer {
        return new ToolGroupPack('schedule', [
            this._setTool(),
            this._listTool(),
            this._cancelTool(),
        ]).createLayer();
    }

    /**
     * Operator-facing read-only view of reminders across one or all agents.
     * Used by Telegram slash commands to inspect runtime schedules.
     */
    async inspectReminders(targetHandle?: string): Promise<ScheduleReminderView[]> {
        const normalize = (h: string) => h.replace(/^@/, '');
        const handles = targetHandle
            ? [normalize(targetHandle)]
            : [...this.agentStates.keys()].sort();

        const rows: ScheduleReminderView[] = [];
        for (const handle of handles) {
            const state = this.agentStates.get(handle);
            if (!state) continue;

            for (const r of state.cronReminders.values()) {
                rows.push({
                    owner: `@${handle}`,
                    id: r.id,
                    type: 'cron',
                    schedule: r.cron,
                    message: r.message,
                    persisted: !!state.store,
                });
            }

            for (const id of state.onceTimers.keys()) {
                let message = '(unknown)';
                let firesAt = '(pending)';
                if (state.store) {
                    try {
                        const stored = await state.store.namespace(this._onceNs(handle)).get<StoredOnceReminder>(id);
                        if (stored) {
                            message = stored.message;
                            firesAt = new Date(stored.firesAt).toISOString();
                        }
                    } catch { /* best-effort */ }
                }
                rows.push({
                    owner: `@${handle}`,
                    id,
                    type: 'once',
                    schedule: firesAt,
                    message,
                    persisted: !!state.store,
                });
            }
        }

        return rows.sort((a, b) =>
            a.owner.localeCompare(b.owner) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
        );
    }

    // ─── Boot ────────────────────────────────────────────────────

    private async _bootAgent(state: AgentState): Promise<void> {
        if (state.scheduler && state.store) {
            try {
                const stored = await state.store
                    .namespace(this._cronNs(state.handle))
                    .scan<StoredCronReminder>();
                for (const r of Object.values(stored)) {
                    this._scheduleCron(state, r);
                    state.cronReminders.set(r.id, r);
                }
            } catch { /* non-fatal */ }
        }

        if (state.store) {
            try {
                const ns = state.store.namespace(this._onceNs(state.handle));
                const stored = await ns.scan<StoredOnceReminder>();
                const now = Date.now();
                for (const r of Object.values(stored)) {
                    if (r.firesAt <= now) {
                        // Past due — fire and clean up.
                        this._fire(state, r.id, r.message);
                        ns.delete(r.id).catch(() => { /* best-effort */ });
                    } else {
                        this._armOnce(state, r, ns);
                    }
                }
            } catch { /* non-fatal */ }
        }
    }

    // ─── Internal ────────────────────────────────────────────────

    private _cronNs(handle: string): string { return `ivy:schedule:${handle}:cron`; }
    private _onceNs(handle: string): string { return `ivy:schedule:${handle}:once`; }

    private _getState(callerHandle: string): AgentState | undefined {
        return this.agentStates.get(callerHandle.replace(/^@/, ''));
    }

    private _fire(state: AgentState, id: string, message: string): void {
        state.observeFn?.(`[reminder:${id}] ${message}`);
    }

    private _scheduleCron(state: AgentState, r: StoredCronReminder): void {
        if (!state.scheduler) return;
        state.scheduler.schedule(
            r.cron,
            () => this._fire(state, r.id, r.message),
            cronJobName(state.handle, r.id),
        );
    }

    private _armOnce(state: AgentState, r: StoredOnceReminder, ns: IStore): void {
        const delayMs = Math.max(0, r.firesAt - Date.now());
        const timer = setTimeout(() => {
            this._fire(state, r.id, r.message);
            state.onceTimers.delete(r.id);
            ns.delete(r.id).catch(() => { /* best-effort */ });
        }, delayMs);
        state.onceTimers.set(r.id, timer);
    }

    // ─── Tools ───────────────────────────────────────────────────

    private _setTool(): Tool {
        const self = this;
        return {
            name: 'set',
            description: [
                'Schedule a reminder that fires as an internal observation when due.',
                'type="cron": recurring, 5-field cron expression (e.g. "0 9 * * *" = 9am daily).',
                'type="once": single, fires at an ISO 8601 datetime (e.g. "2026-06-01T09:00:00").',
                'Persisted across restarts when IStore is available.',
            ].join(' '),
            parameters: {
                id:       { type: 'string', description: 'Unique reminder id (e.g. "daily-check")', required: true },
                message:  { type: 'string', description: 'Text injected as observation when the reminder fires', required: true },
                type:     { type: 'string', description: '"cron" for recurring | "once" for a single datetime', required: true },
                schedule: { type: 'string', description: 'Cron expression (type=cron) or ISO 8601 datetime (type=once)', required: true },
            },
            returns: '{ ok, id, type, schedule, message, persisted, note } or { error }',
            handler: async (args, callerHandle) => {
                const state = self._getState(callerHandle);
                if (!state) return { error: `Scheduling not configured for ${callerHandle}` };

                const id       = String(args['id']       ?? '').trim();
                const message  = String(args['message']  ?? '').trim();
                const type     = String(args['type']     ?? '').trim();
                const schedule = String(args['schedule'] ?? '').trim();

                if (!id)      return { error: 'id is required' };
                if (!message) return { error: 'message is required' };
                if (type !== 'cron' && type !== 'once') return { error: 'type must be "cron" or "once"' };

                // ── Cron ──────────────────────────────────────────────
                if (type === 'cron') {
                    if (!state.scheduler) {
                        return { error: 'IScheduler unavailable — cron reminders require it' };
                    }
                    if (!isValidCron(schedule)) {
                        return { error: `Invalid cron expression "${schedule}". Expected 5 fields, e.g. "0 9 * * *"` };
                    }

                    // Replace any existing cron with this id.
                    try { state.scheduler.unschedule(cronJobName(state.handle, id)); } catch { /* ok */ }

                    const reminder: StoredCronReminder = { id, message, cron: schedule, createdAt: Date.now() };

                    if (state.store) {
                        try {
                            await state.store.namespace(self._cronNs(state.handle)).set(id, reminder);
                        } catch { /* non-fatal */ }
                    }

                    try {
                        self._scheduleCron(state, reminder);
                    } catch (err) {
                        // IScheduler validated the expression more strictly — roll back IStore write.
                        if (state.store) {
                            try { await state.store.namespace(self._cronNs(state.handle)).delete(id); } catch { /* best-effort */ }
                        }
                        return { error: `Failed to schedule cron "${schedule}": ${String(err)}` };
                    }

                    state.cronReminders.set(id, reminder);

                    return {
                        ok: true, id, type: 'cron', schedule, message,
                        persisted: !!state.store,
                        note: state.store ? 'Persisted — survives restarts.' : 'Ephemeral — lost on restart (IStore unavailable).',
                    };
                }

                // ── Once ──────────────────────────────────────────────
                const target = new Date(schedule);
                if (isNaN(target.getTime())) {
                    return { error: `Invalid datetime "${schedule}". Use ISO 8601, e.g. "2026-06-01T09:00:00"` };
                }

                const delayMs = target.getTime() - Date.now();
                if (delayMs <= 0) {
                    const ago = Math.abs(Math.round(delayMs / 60_000));
                    return { error: `Datetime "${schedule}" is in the past (${ago}m ago)` };
                }

                // Replace any existing once with this id.
                const existing = state.onceTimers.get(id);
                if (existing !== undefined) {
                    clearTimeout(existing);
                    state.onceTimers.delete(id);
                }

                const r: StoredOnceReminder = { id, message, firesAt: target.getTime(), createdAt: Date.now() };

                if (state.store) {
                    const ns = state.store.namespace(self._onceNs(state.handle));
                    try { await ns.set(id, r); } catch { /* non-fatal */ }
                    self._armOnce(state, r, ns);
                } else {
                    const timer = setTimeout(() => {
                        self._fire(state, id, message);
                        state.onceTimers.delete(id);
                    }, delayMs);
                    state.onceTimers.set(id, timer);
                }

                return {
                    ok: true, id, type: 'once',
                    firesAt: target.toISOString(),
                    minutesUntil: Math.round(delayMs / 60_000),
                    message,
                    persisted: !!state.store,
                    note: state.store ? 'Persisted — survives restarts.' : 'Ephemeral — lost on restart (IStore unavailable).',
                };
            },
        };
    }

    private _listTool(): Tool {
        const self = this;
        return {
            name: 'list',
            description: 'List all active reminders for this agent (recurring cron and pending one-shot).',
            parameters: {},
            returns: '{ count, reminders: [{ id, type, schedule, message, persisted }] }',
            handler: async (_args, callerHandle) => {
                const state = self._getState(callerHandle);
                if (!state) return { error: `Scheduling not configured for ${callerHandle}` };

                type Row = { id: string; type: string; schedule: string; message: string; persisted: boolean };
                const rows: Row[] = [];

                // Cron reminders from in-memory map (source of truth).
                for (const r of state.cronReminders.values()) {
                    rows.push({ id: r.id, type: 'cron', schedule: r.cron, message: r.message, persisted: !!state.store });
                }

                // Pending one-shot timers.
                for (const id of state.onceTimers.keys()) {
                    let message = '(unknown)';
                    let firesAt = '(pending)';
                    if (state.store) {
                        try {
                            const r = await state.store.namespace(self._onceNs(state.handle)).get<StoredOnceReminder>(id);
                            if (r) { message = r.message; firesAt = new Date(r.firesAt).toISOString(); }
                        } catch { /* ignore */ }
                    }
                    rows.push({ id, type: 'once', schedule: firesAt, message, persisted: !!state.store });
                }

                return { count: rows.length, reminders: rows };
            },
        };
    }

    private _cancelTool(): Tool {
        const self = this;
        return {
            name: 'cancel',
            description: 'Cancel a reminder by id. Works for both cron and one-shot reminders.',
            parameters: {
                id: { type: 'string', description: 'The reminder id to cancel', required: true },
            },
            returns: '{ ok, id } or { error }',
            handler: async (args, callerHandle) => {
                const state = self._getState(callerHandle);
                if (!state) return { error: `Scheduling not configured for ${callerHandle}` };

                const id = String(args['id'] ?? '').trim();
                if (!id) return { error: 'id is required' };

                let found = false;

                // Cron: in-memory map is the source of truth.
                if (state.cronReminders.has(id)) {
                    state.cronReminders.delete(id);
                    found = true;
                    try { state.scheduler?.unschedule(cronJobName(state.handle, id)); } catch { /* ok */ }
                    if (state.store) {
                        try { await state.store.namespace(self._cronNs(state.handle)).delete(id); } catch { /* best-effort */ }
                    }
                }

                // Once: timer map is the source of truth.
                const timer = state.onceTimers.get(id);
                if (timer !== undefined) {
                    clearTimeout(timer);
                    state.onceTimers.delete(id);
                    found = true;
                }
                if (state.store) {
                    try {
                        if (await state.store.namespace(self._onceNs(state.handle)).delete(id)) found = true;
                    } catch { /* ignore */ }
                }

                if (!found) return { error: `No reminder found with id "${id}"` };
                return { ok: true, id };
            },
        };
    }
}
