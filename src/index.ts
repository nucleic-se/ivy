import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Bundle, IFetcher, ILLMProvider, IScheduler, IStore, LLMProviderOptions } from '@nucleic-se/gears';
import { createLLMProvider } from '@nucleic-se/gears';
import { IvyServiceProvider } from './IvyServiceProvider.js';
import { LLMAgent } from './LLMAgent.js';
import { AgentParticipant } from './AgentParticipant.js';
import { TelegramParticipant } from './TelegramParticipant.js';
import { Sandbox } from './sandbox/Sandbox.js';
import { TextToolPack } from './packs/TextToolPack.js';
import { FetchToolPack } from './packs/FetchToolPack.js';
import { FsToolPack } from './packs/FsToolPack.js';
import { ValidateToolPack } from './packs/ValidateToolPack.js';
import { JsonToolPack } from './packs/JsonToolPack.js';
import { ScheduleToolPack } from './packs/ScheduleToolPack.js';
import { HistoryToolPack } from './packs/HistoryToolPack.js';
import { LedgerToolPack } from './packs/LedgerToolPack.js';
import { SopToolPack } from './packs/SopToolPack.js';
import { ManifestToolPack } from './packs/ManifestToolPack.js';
import { BatchToolPack } from './packs/BatchToolPack.js';
import { SnapshotToolPack } from './packs/SnapshotToolPack.js';
import { ContextToolPack } from './packs/ContextToolPack.js';
import { IndexToolPack } from './packs/IndexToolPack.js';
import { NotifyToolPack } from './packs/NotifyToolPack.js';
import { ScriptToolPack } from './packs/ScriptToolPack.js';
import { logCommand } from './logCommand.js';
import type { Room } from './Room.js';

export { Room } from './Room.js';
export { RoomLog } from './RoomLog.js';
export { LLMAgent } from './LLMAgent.js';
export { AgentParticipant } from './AgentParticipant.js';
export { AIParticipant } from './AIParticipant.js'; // backward compat
export { TelegramParticipant } from './TelegramParticipant.js';
export type { Message, Participant, Agent, AgentContext, AgentAction, WakeMode, FsAction, CallAction, FsOp } from './types.js';
export { isVisibleTo } from './types.js';
export { Sandbox } from './sandbox/Sandbox.js';
export type { ToolManifest } from './sandbox/types.js';
export { ToolGroupPack } from './sandbox/ToolGroupPack.js';
export type { Tool, ToolParam } from './sandbox/ToolGroupPack.js';
export type { SandboxLayer, LayerContext } from './sandbox/layer.js';
export { TextToolPack } from './packs/TextToolPack.js';
export { FetchToolPack } from './packs/FetchToolPack.js';
export { FsToolPack } from './packs/FsToolPack.js';
export { ValidateToolPack } from './packs/ValidateToolPack.js';
export { JsonToolPack } from './packs/JsonToolPack.js';
export { ScheduleToolPack } from './packs/ScheduleToolPack.js';
export { HistoryToolPack } from './packs/HistoryToolPack.js';
export { LedgerToolPack } from './packs/LedgerToolPack.js';
export type { LedgerTask } from './packs/LedgerToolPack.js';
export { SopToolPack } from './packs/SopToolPack.js';
export { ManifestToolPack } from './packs/ManifestToolPack.js';
export { BatchToolPack } from './packs/BatchToolPack.js';
export { SnapshotToolPack } from './packs/SnapshotToolPack.js';
export { ContextToolPack } from './packs/ContextToolPack.js';
export { IndexToolPack } from './packs/IndexToolPack.js';
export { NotifyToolPack } from './packs/NotifyToolPack.js';
export { ScriptToolPack } from './packs/ScriptToolPack.js';

// ─── Agent discovery ─────────────────────────────────────────────────────────

interface AgentConfig {
    displayName: string;
    wakeOn?: 'all' | 'mentions' | 'dm' | 'none';
    scheduleReminders?: boolean;
    integrityGate?: boolean;
}

interface DiscoveredAgent extends AgentConfig {
    handle: string;
    systemPrompt: string;
}

/**
 * Scan `<sandboxRoot>/home/` for agent directories.
 * An agent directory is any non-underscore-prefixed subdirectory containing a `config.json`.
 * `system-prompt.md` is optional — loaded if present, empty string otherwise.
 * Underscore-prefixed directories (e.g. `_agent`) are skipped (template marker).
 */
function discoverAgents(
    sandboxRoot: string,
    logger: { warn(message: string, context?: Record<string, unknown>): void },
): DiscoveredAgent[] {
    const homeDir = path.join(sandboxRoot, 'home');
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(homeDir, { withFileTypes: true });
    } catch {
        logger.warn('Agent discovery: could not read home directory', { homeDir });
        return [];
    }

    const agents: DiscoveredAgent[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_')) continue;

        const configPath = path.join(homeDir, entry.name, 'config.json');
        if (!fs.existsSync(configPath)) continue;

        let config: AgentConfig;
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AgentConfig;
        } catch (err) {
            logger.warn(`Agent discovery: skipping home/${entry.name} — invalid config.json`, {
                error: (err as Error).message,
            });
            continue;
        }

        if (!config.displayName) {
            logger.warn(`Agent discovery: skipping home/${entry.name} — config.json missing displayName`);
            continue;
        }

        const promptPath = path.join(homeDir, entry.name, 'system-prompt.md');
        const systemPrompt = fs.existsSync(promptPath)
            ? fs.readFileSync(promptPath, 'utf8').trim()
            : '';

        agents.push({ handle: `@${entry.name}`, systemPrompt, ...config });
    }

    return agents;
}

// ─────────────────────────────────────────────────────────────────────────────

const bundle: Bundle = (() => {
    // Instance-scoped lifecycle state — safe even if multiple app instances exist.
    let activeParticipants: AgentParticipant[] = [];
    let activeTelegram: TelegramParticipant | undefined;
    let activeRoom: Room | undefined;
    let activeScheduler: IScheduler | null = null;
    let started = false;
    let integrityGateRunning = false;

    const INTEGRITY_GATE_JOB_NAME = 'ivy:integrity-gate';
    const INTEGRITY_GATE_CRON = '*/30 * * * *';

    return {
        name: 'ivy',
        version: '0.1.0',
        description: 'Multi-agent chatroom.',
        requires: ['notifications'],
        providers: [IvyServiceProvider],
        commands: [logCommand],

        async init(app) {
            if (started) return;
            const logger = app.make('ILogger');
            const defaultLlm = app.make('ILLMProvider') as ILLMProvider;
            const events = app.make('IEventBus');
            const room = app.make('ivy.Room');

            try {
                const fetcher = app.make('IFetcher') as IFetcher;
                const metrics = (app.makeOrNull('IMetrics') ?? undefined) as LLMProviderOptions['metrics'];

                async function agentLlm(handle: string): Promise<ILLMProvider> {
                    const key = `${handle.replace('@', '').toUpperCase()}_LLM_PROVIDER`;
                    const override = process.env[key];
                    if (!override) return defaultLlm;
                    return createLLMProvider({ provider: override, metrics, fetcher });
                }

                let scheduler: IScheduler | null = null;
                let store: IStore | null = null;
                try { scheduler = app.make('IScheduler'); } catch { /* optional */ }
                try { store = app.make('IStore'); } catch { /* optional */ }
                activeScheduler = scheduler;

                const sandbox = new Sandbox();
                sandbox.mount(new TextToolPack(sandbox).createLayer());
                sandbox.mount(new FetchToolPack(fetcher, sandbox).createLayer());
                sandbox.mount(new FsToolPack(sandbox).createLayer());
                sandbox.mount(new ValidateToolPack(sandbox).createLayer());
                sandbox.mount(new JsonToolPack(sandbox).createLayer());
                sandbox.mount(new HistoryToolPack(room).createLayer());
                sandbox.mount(new LedgerToolPack(sandbox).createLayer());
                // sandbox.mount(new SopToolPack(sandbox).createLayer());      // disabled: niche prerequisite format, not adopted
                // sandbox.mount(new ManifestToolPack(sandbox).createLayer()); // disabled: superseded by validate/run MANIFEST_UNDOC
                sandbox.mount(new BatchToolPack(sandbox).createLayer());
                // sandbox.mount(new SnapshotToolPack(sandbox).createLayer()); // disabled: only 2 organic calls in full history; batch/apply rollback covers the use case
                sandbox.mount(new ContextToolPack(sandbox).createLayer());
                sandbox.mount(new IndexToolPack(sandbox).createLayer());
                sandbox.mount(new NotifyToolPack(events).createLayer());
                sandbox.mount(new ScriptToolPack(sandbox).createLayer());

                const parseCallJson = (raw: string): Record<string, unknown> => {
                    const arrow = raw.indexOf(' → ');
                    if (arrow === -1) throw new Error(`Unexpected tool response format: ${raw}`);
                    return JSON.parse(raw.slice(arrow + 3)) as Record<string, unknown>;
                };

                // Per-agent schedule tools — single layer, routed by callerHandle.
                // onFire bridges reminder delivery to notification channels (telegram/slack).
                const reminderOnFire = (id: string, message: string, notify: string) => {
                    const event = notify === 'slack' ? 'notification:slack' : 'notification:telegram';
                    events.emit(event, { title: `Reminder: ${id}`, message });
                };

                // ── Agent discovery ─────────────────────────────────────
                // Agents are defined by config.json + system-prompt.md in home/<handle>/.
                // Underscore-prefixed directories (e.g. _agent) are skipped (template marker).
                const discovered = discoverAgents(sandbox.root, logger);
                if (discovered.length === 0) {
                    logger.warn('No agent configs found in home/ — sandbox has no LLM agents. Deploy a survival pack and restart to activate agents.');
                }

                const schedulePack = new ScheduleToolPack();
                for (const cfg of discovered) {
                    if (cfg.scheduleReminders) {
                        schedulePack.registerAgent(cfg.handle, { scheduler, store, onFire: reminderOnFire });
                    }
                }
                sandbox.mount(schedulePack.createLayer());

                // ── Participants (room adapters) ────────────────────────
                const onDegraded = (handle: string): void => {
                    events.emit('notification:slack', {
                        title: `${handle} degraded`,
                        message: `LLM provider returning repeated errors. Queue preserved — agent will recover automatically when the provider responds.`,
                    });
                };

                const baseConfig = store ? { sandbox, store, onDegraded } : { sandbox, onDegraded };

                const agentParticipants: AgentParticipant[] = [];
                let integrityGateTarget: AgentParticipant | undefined;

                for (const cfg of discovered) {
                    const llmAgent = new LLMAgent({
                        handle: cfg.handle,
                        displayName: cfg.displayName,
                        systemPrompt: cfg.systemPrompt,
                        sandbox,
                    }, await agentLlm(cfg.handle));

                    const wakeMode = (cfg.wakeOn ?? 'mentions') as 'all' | 'mentions' | 'dm' | 'none';
                    const participant = new AgentParticipant(
                        llmAgent, room, { ...baseConfig, wakeMode }, logger,
                    );

                    room.join(participant);

                    if (cfg.scheduleReminders) {
                        schedulePack.setObserve(cfg.handle, text => participant.observe(text));
                    }
                    if (cfg.integrityGate) {
                        integrityGateTarget = participant;
                    }

                    agentParticipants.push(participant);
                }

                const architect = new TelegramParticipant({
                    handle: '@architect',
                    displayName: 'Architect',
                    sandbox,
                    scheduleInspector: {
                        list: (targetHandle?: string) => schedulePack.inspectReminders(targetHandle),
                    },
                }, room, events, logger);

                // ── Wire up ─────────────────────────────────────────────
                // join() before boot() — boot() may fire past-due reminders synchronously
                // via observe() → room.note(), which requires room membership.
                room.join(architect);
                await schedulePack.boot();

                for (const p of agentParticipants) p.start();
                architect.start();

                const runIntegrityGate = async (trigger: 'startup' | 'scheduled'): Promise<void> => {
                    if (integrityGateRunning) return;
                    integrityGateRunning = true;
                    try {
                        const scopes = ['/home', '/data'] as const; // Intentionally excludes /tmp (scratch space).
                        const violations: Array<{ scope: string; rule: string; path: string; hint: string }> = [];
                        for (const scope of scopes) {
                            const raw = await sandbox.execCall('validate/run', { path: scope }, '@sentinel');
                            const result = parseCallJson(raw);
                            const scopeViolations = (result['violations'] as Array<Record<string, unknown>> | undefined) ?? [];
                            for (const v of scopeViolations) {
                                violations.push({
                                    scope,
                                    rule: String(v['rule'] ?? 'UNKNOWN'),
                                    path: String(v['path'] ?? scope),
                                    hint: String(v['hint'] ?? ''),
                                });
                            }
                        }

                        if (violations.length === 0) {
                            logger.info('Sandbox integrity gate passed', {
                                trigger,
                                scopes: ['/home', '/data'],
                                excluded: ['/tmp'],
                            });
                            return;
                        }

                        const sample = violations.slice(0, 10)
                            .map(v => `- ${v.rule} @ ${v.path}${v.hint ? ` — ${v.hint}` : ''}`)
                            .join('\n');
                        const summary = [
                            `[integrity:${trigger}] FAIL — ${violations.length} violation(s) across /home and /data.`,
                            'Scope excludes /tmp by design.',
                            sample,
                        ].join('\n');
                        integrityGateTarget?.observe(summary);
                        logger.warn('Sandbox integrity gate failed', {
                            trigger,
                            violations: violations.length,
                            excluded: ['/tmp'],
                        });
                    } catch (err) {
                        const message = `[integrity:${trigger}] ERROR — ${(err as Error).message}`;
                        integrityGateTarget?.observe(message);
                        logger.error('Sandbox integrity gate error', { trigger, error: (err as Error).message });
                    } finally {
                        integrityGateRunning = false;
                    }
                };

                await runIntegrityGate('startup');
                if (scheduler) {
                    try { scheduler.unschedule(INTEGRITY_GATE_JOB_NAME); } catch { /* best-effort */ }
                    scheduler.schedule(
                        INTEGRITY_GATE_CRON,
                        () => { void runIntegrityGate('scheduled'); },
                        INTEGRITY_GATE_JOB_NAME,
                    );
                }

                activeParticipants = agentParticipants;
                activeTelegram = architect;
                activeRoom = room;
                started = true;

                const agentHandles = discovered.map(c => c.handle);
                logger.info('Ivy chatroom started', { participants: [...agentHandles, '@architect'] });
            } catch (err) {
                // Best-effort rollback for partial init.
                activeParticipants.forEach(a => a.stop());
                activeTelegram?.stop();
                for (const { handle } of room.getParticipants()) {
                    try { room.leave(handle); } catch { /* ignore */ }
                }
                try { activeScheduler?.unschedule(INTEGRITY_GATE_JOB_NAME); } catch { /* ignore */ }
                activeParticipants = [];
                activeTelegram = undefined;
                activeRoom = undefined;
                activeScheduler = null;
                started = false;
                throw err;
            }
        },

        async shutdown() {
            if (!started) return;
            activeParticipants.forEach(a => a.stop());
            activeTelegram?.stop();
            try { activeScheduler?.unschedule(INTEGRITY_GATE_JOB_NAME); } catch { /* ignore */ }
            for (const { handle } of (activeRoom?.getParticipants() ?? [])) {
                try { activeRoom?.leave(handle); } catch { /* ignore */ }
            }
            activeParticipants = [];
            activeTelegram = undefined;
            activeRoom = undefined;
            activeScheduler = null;
            started = false;
        },
    };
})();

export default bundle;
