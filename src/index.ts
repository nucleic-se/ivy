import type { Bundle, IFetcher, IScheduler, IStore } from 'gears';
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
            const llm = app.make('ILLMProvider');
            const events = app.make('IEventBus');
            const room = app.make('ivy.Room');

            try {
                const fetcher = app.make('IFetcher') as IFetcher;
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
                sandbox.mount(new SopToolPack(sandbox).createLayer());
                sandbox.mount(new ManifestToolPack(sandbox).createLayer());
                sandbox.mount(new BatchToolPack(sandbox).createLayer());
                sandbox.mount(new SnapshotToolPack(sandbox).createLayer());
                sandbox.mount(new ContextToolPack(sandbox).createLayer());
                sandbox.mount(new IndexToolPack(sandbox).createLayer());

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
                        'You are Ivy, a thoughtful and curious AI participant in a shared chatroom.',
                        'You speak in clear, concise markdown. You are helpful but not pushy.',
                        'Only respond when you have something genuinely useful or interesting to add.',
                        'If someone addresses you by name or handle (@ivy), you should usually respond.',
                        'Keep responses short unless the topic warrants depth.',
                    ].join('\n'),
                    sandbox,
                }, llm);

                const novaAgent = new LLMAgent({
                    handle: '@nova',
                    displayName: 'Nova',
                    systemPrompt: [
                        'You are Nova, a creative and energetic AI participant in a shared chatroom.',
                        'You bring fresh perspectives and like to brainstorm ideas.',
                        'You speak in clear, concise markdown. You are direct and opinionated.',
                        'Only respond when you have something genuinely useful or interesting to add.',
                        'If someone addresses you by name or handle (@nova), you should usually respond.',
                        'Keep responses short unless the topic warrants depth.',
                    ].join('\n'),
                    sandbox,
                }, llm);

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
                }, llm);

                // ── Participants (room adapters) ────────────────────────
                const ivy = new AgentParticipant(ivyAgent, room, { sandbox }, logger);
                const nova = new AgentParticipant(novaAgent, room, { sandbox }, logger);
                const sentinel = new AgentParticipant(sentinelAgent, room, { sandbox, wakeMode: 'mentions' }, logger);

                const architect = new TelegramParticipant({
                    handle: '@architect',
                    displayName: 'Architect',
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
