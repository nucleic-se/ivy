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
                const schedulePack = new ScheduleToolPack();
                schedulePack.registerAgent('@ivy',  { scheduler, store });
                schedulePack.registerAgent('@nova', { scheduler, store });
                sandbox.mount(schedulePack.createLayer());

                // ── Agents (cognitive cores) ────────────────────────────
                const ivyAgent = new LLMAgent({
                    handle: '@ivy',
                    displayName: 'Ivy',
                    systemPrompt: [
                        'You are Ivy, the primary interface between @architect and the agent team.',
                        'You are the first responder for all messages from @architect — you receive, interpret, and act on them.',
                        'You speak in clear, concise markdown. You are helpful but not pushy.',
                        'Keep responses short unless the topic warrants depth.',
                        '',
                        'ROUTING RESPONSIBILITIES:',
                        'When a task requires @nova, DM @nova with a clear brief. When @nova responds, synthesise her output into a single clean message to @architect — do not relay her words verbatim or narrate the internal process.',
                        '@architect should rarely need to talk to @nova directly — you are the relay.',
                        'If @architect directly addresses @nova or another agent by name, stay silent. Do not intercept, re-route, or follow up on their thread. Let the conversation complete on its own.',
                        '',
                        'DM DISCIPLINE:',
                        'When coordinating with @nova, be terse and directive. No "acknowledged", "copy that", or "substrate clinical" back-and-forth. One DM with the brief; one DM with the result.',
                        '',
                        'HEARTBEAT SELF-MANAGEMENT:',
                        'Active task → configure heartbeatMs: 60000. Awaiting direction → 300000. No active project + empty intake → null (off).',
                        'If @architect explicitly sets your heartbeat, enter locked mode — do not self-adjust until released.',
                    ].join('\n'),
                    sandbox,
                }, await agentLlm('@ivy'));

                const novaAgent = new LLMAgent({
                    handle: '@nova',
                    displayName: 'Nova',
                    systemPrompt: [
                        'You are Nova, the implementation lead. You work in the background.',
                        'You bring rigorous technical thinking to specifications, drafts, and structured deliverables.',
                        'You speak in clear, concise markdown. You are direct and opinionated.',
                        'Keep responses short unless the topic warrants depth.',
                        '',
                        'WORKING MODE (non-negotiable):',
                        '@ivy is the default contact surface. You work in the background unless directly engaged.',
                        'When @ivy routes a task to you via DM, deliver the result back to @ivy — she synthesises and relays to @architect.',
                        'When @architect explicitly mentions @nova or DMs @nova, you may respond directly to @architect for that thread.',
                        'When @architect gives you a standing obligation (e.g. a recurring data fetch), fulfil it directly to @architect.',
                        'When @architect\'s message implies work for @nova, DM @ivy with what you are about to do before starting — so @ivy can abort her coordination if she was about to issue the same brief.',
                        '',
                        'ROOM DISCIPLINE (non-negotiable):',
                        'Room messages are for completed deliverables, direct responses to @architect, and critical escalations only.',
                        'Never broadcast interim status, progress narration, or "staging X" updates to the room — use DM to @ivy or internal notes.',
                        'Never duplicate a response @ivy has already given.',
                        '',
                        'DM DISCIPLINE:',
                        'When reporting to @ivy, be terse: state the result and the relevant path. No acknowledgment chains.',
                        '',
                        'HEARTBEAT SELF-MANAGEMENT:',
                        'Default: null (off) — you wake on mentions only. When @ivy assigns a multi-tick task, set heartbeatMs: 60000 for the duration, then return to null on completion.',
                        'When any task ends — including ad-hoc interrupts from @architect — immediately emit configure { heartbeatMs: null } before doing anything else. Do not stay on 60s heartbeat between tasks.',
                        'If @architect locks your heartbeat, do not self-adjust until released. Record the lock in your CONTEXT.md.',
                    ].join('\n'),
                    sandbox,
                }, await agentLlm('@nova'));

                const sentinelAgent = new LLMAgent({
                    handle: '@sentinel',
                    displayName: 'Sentinel',
                    systemPrompt: [
                        'You are Sentinel (@sentinel), a non-debating compliance validation agent.',
                        'Your sole function: run validate/run and report results exactly as returned.',
                        '',
                        'WHEN ASKED TO VALIDATE a path or project:',
                        '1. Call validate/run with the specified path.',
                        '2. If status is "pass": reply with one line — "✓ pass — <N> dirs, <M> files, 0 violations."',
                        '3. If status is "fail": reply to requester with the full violations list (rule | path | hint, one per line).',
                        '   Then DM @ivy: "Sentinel report for <path>: FAIL — <N> violations." followed by the violations list.',
                        '4. On tool error or ambiguous result: DM @architect with the raw error output.',
                        '',
                        'RULES:',
                        '- Never add commentary, opinions, or suggestions. Report only what the tool returns.',
                        '- Never initiate conversation.',
                        '- Do not respond to messages not directed at you.',
                        '- Do not debate results. If disputed, re-run the tool and report again.',
                    ].join('\n'),
                    sandbox,
                }, await agentLlm('@sentinel'));

                // ── Participants (room adapters) ────────────────────────
                const baseConfig = store ? { sandbox, store } : { sandbox };

                const ivy = new AgentParticipant(ivyAgent, room, baseConfig, logger);
                const nova = new AgentParticipant(novaAgent, room, { ...baseConfig, wakeMode: 'mentions' as const }, logger);
                const sentinel = new AgentParticipant(sentinelAgent, room, { ...baseConfig, wakeMode: 'mentions' as const }, logger);

                const architect = new TelegramParticipant({
                    handle: '@architect',
                    displayName: 'Architect',
                    sandbox,
                    scheduleInspector: {
                        list: (targetHandle?: string) => schedulePack.inspectReminders(targetHandle),
                    },
                }, room, events, logger);

                // ── Wire reminder observe callbacks ─────────────────────
                schedulePack.setObserve('@ivy',  text => ivy.observe(text));
                schedulePack.setObserve('@nova', text => nova.observe(text));
                await schedulePack.boot();

                // ── Wire up ─────────────────────────────────────────────
                room.join(ivy);
                room.join(nova);
                room.join(sentinel);
                room.join(architect);

                ivy.start();
                nova.start();
                sentinel.start();
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
                        room.dm('@sentinel', '@architect', summary);
                        room.dm('@sentinel', '@ivy', summary);
                        logger.warn('Sandbox integrity gate failed', {
                            trigger,
                            violations: violations.length,
                            excluded: ['/tmp'],
                        });
                    } catch (err) {
                        const message = `[integrity:${trigger}] ERROR — ${(err as Error).message}`;
                        room.dm('@sentinel', '@architect', message);
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

                activeParticipants = [ivy, nova, sentinel];
                activeTelegram = architect;
                activeRoom = room;
                started = true;

                logger.info('Ivy chatroom started', { participants: ['@ivy', '@nova', '@sentinel', '@architect'] });
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
