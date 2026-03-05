/**
 * TelegramParticipant — bridges Telegram into the chatroom via the
 * gears notifications bundle.
 *
 * Inbound:  listens for 'notification:receive' events on IEventBus
 *           and posts them to the room as the human.
 * Outbound: subscribes to room messages (via receive()) and sends
 *           non-self messages to Telegram via 'notification:send',
 *           subject to the active ViewFilter.
 *
 * Slash commands
 * ──────────────
 * Commands are registered in a Map in the constructor so that unknown
 * commands can dynamically list all available options, and new commands
 * require no changes to dispatch logic.
 *
 *   /help                 — list all available commands
 *   /dm @handle message   — send a direct message to a participant
 *   /who                  — list participants in the room
 *   /mute [on|off] [@h]   — mute control (status, set, clear-all)
 *   /focus [on|off]       — focus mode control
 *   /filters              — display current filter state
 *   /wiretap [on|off|toggle|status] — wiretap mode control
 *   /mdraw <path-or-query> — read markdown as plain text (no Telegram markdown parsing)
 */

import type { IEventBus } from '@nucleic-se/gears';
import type { ILogger } from '@nucleic-se/gears';
import type { Message, Participant } from './types.js';
import type { Room } from './Room.js';
import { ViewFilter } from './ViewFilter.js';
import type { Sandbox } from './sandbox/Sandbox.js';
import type { ScheduleReminderView } from './packs/ScheduleToolPack.js';

interface Command {
    description: string;
    handler: (raw: string) => void;
}

export interface TelegramParticipantConfig {
    handle: string;
    displayName: string;
    sandbox?: Sandbox;
    scheduleInspector?: {
        list: (targetHandle?: string) => Promise<ScheduleReminderView[]>;
    };
}

export class TelegramParticipant implements Participant {
    readonly handle: string;
    readonly displayName: string;

    private room: Room;
    private events: IEventBus;
    private logger?: ILogger;
    private unsubscribe?: () => void;
    private filter = new ViewFilter();
    private wiretapMode = false;
    private wiretapUnsubscribe?: () => void;
    private readonly commands: Map<string, Command>;
    private readonly sandbox?: Sandbox;
    private readonly scheduleInspector?: {
        list: (targetHandle?: string) => Promise<ScheduleReminderView[]>;
    };
    private static readonly TELEGRAM_MAX_CHARS = 3900;

    constructor(config: TelegramParticipantConfig, room: Room, events: IEventBus, logger?: ILogger) {
        this.handle = config.handle;
        this.displayName = config.displayName;
        this.room = room;
        this.events = events;
        this.logger = logger;
        this.sandbox = config.sandbox;
        this.scheduleInspector = config.scheduleInspector;
        this.commands = new Map([
            ['help',    { description: 'List all available commands', handler: () => this.cmdHelp() }],
            ['dm',      { description: 'Send a direct message: /dm @handle message', handler: (raw: string) => this.cmdDm(raw) }],
            ['who',     { description: 'List participants in the room', handler: () => this.cmdWho() }],
            ['mute',    { description: 'Mute control: /mute [on|off] [@handle]', handler: (raw: string) => this.cmdMute(raw) }],
            ['focus',   { description: 'Focus mode: /focus [on|off]', handler: (raw: string) => this.cmdFocus(raw) }],
            ['filters', { description: 'Display current filter state', handler: () => this.cmdFilters() }],
            ['wiretap', { description: 'Wiretap mode: /wiretap [on|off|toggle|status]', handler: (raw: string) => this.cmdWiretap(raw) }],
            ['schedules', { description: 'List active reminders: /schedules [@handle]', handler: (raw: string) => { void this.cmdSchedules(raw); } }],
            ['tools',   { description: 'List sandbox tools', handler: () => this.cmdTools() }],
            ['ls',      { description: 'List sandbox directory: /ls /path', handler: (raw: string) => { void this.cmdLs(raw); } }],
            ['stat',    { description: 'Stat sandbox path: /stat /path', handler: (raw: string) => { void this.cmdStat(raw); } }],
            ['tree',    { description: 'Render tree: /tree /path [depth]', handler: (raw: string) => { void this.cmdTree(raw); } }],
            ['cat',     { description: 'Read file: /cat /path [from to]', handler: (raw: string) => { void this.cmdCat(raw); } }],
            ['md',      { description: 'Read markdown by path or fuzzy name: /md <path-or-query>', handler: (raw: string) => { void this.cmdMarkdown(raw); } }],
            ['mdraw',   { description: 'Read markdown as plain text: /mdraw /absolute/path.md', handler: (raw: string) => { void this.cmdMarkdownRaw(raw); } }],
        ]);
    }

    /** Called by the room when a visible message is posted. Forward to Telegram if filter allows. */
    receive(message: Message): void {
        // Wiretap subscriber handles all delivery — avoid duplicates.
        if (this.wiretapMode) return;
        if (!this.filter.allows(message, this.handle)) return;
        const prefix = message.to === '*' ? message.from : `${message.from} → you`;
        this.sendToTelegram(prefix, message.text, true);
    }

    /** Start listening for incoming Telegram messages. Idempotent. */
    start(): void {
        if (this.unsubscribe) return; // already listening
        this.unsubscribe = this.events.on('notification:receive', (payload: any) => {
            const text = payload.text?.trim();
            if (!text) return;

            if (payload.kind === 'command') {
                this.handleCommand(payload.key, text);
                return;
            }

            this.room.post(this.handle, text);
        });
    }

    /** Stop listening. Also disables wiretap if active. */
    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        if (this.wiretapMode) {
            this.wiretapUnsubscribe?.();
            this.wiretapUnsubscribe = undefined;
            this.wiretapMode = false;
        }
    }

    // ─── Command dispatch ────────────────────────────────────────

    private handleCommand(key: string, raw: string): void {
        const command = this.commands.get(key);
        if (!command) {
            const available = [...this.commands.keys()].map(k => `/${k}`).join(', ');
            this.sendToTelegram('Unknown command', `/${key} is not recognized.\nAvailable: ${available}`);
            return;
        }
        command.handler(raw);
    }

    // ─── Commands ────────────────────────────────────────────────

    /** /help — list all commands with descriptions */
    private cmdHelp(): void {
        const lines = [...this.commands.entries()]
            .map(([key, cmd]) => `**/${key}** — ${cmd.description}`);
        this.sendToTelegram('Commands', lines.join('\n'), true);
    }

    /** /dm @handle message — send a direct message */
    private cmdDm(raw: string): void {
        const match = raw.match(/^\/dm\s+(@[A-Za-z0-9_-]+)\s+(.+)$/s);
        if (!match) {
            this.sendToTelegram('Usage', '/dm @handle message');
            return;
        }
        const [, target, message] = match;
        this.room.dm(this.handle, target, message);
    }

    /** /who — list participants in the room */
    private cmdWho(): void {
        const participants = this.room.getParticipants();
        const list = participants
            .map(p => `• **${p.displayName}** (${p.handle})`)
            .join('\n');
        this.sendToTelegram('Participants', list || 'No one is here.', true);
    }

    /** /mute [on|off] [@handle] — unified mute control */
    private cmdMute(raw: string): void {
        const m = raw.match(/^\/mute(?:\s+(on|off|toggle|status))?(?:\s+(@[A-Za-z0-9_-]+))?\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/mute [on|off|toggle|status] [@handle]');
            return;
        }
        const mode = m[1];
        const handle = m[2];

        if (!mode && !handle) {
            this.sendToTelegram('Mute state', this.filter.describe());
            return;
        }

        // Backward-compatible: /mute @handle
        if (!mode && handle) {
            this.filter.mute(handle);
            this.sendToTelegram('Filter', `${handle} muted.`);
            return;
        }

        if (!handle) {
            if (mode === 'off') {
                this.filter.unmute();
                this.sendToTelegram('Filter', 'All mutes cleared.');
                return;
            }
            if (mode === 'status') {
                this.sendToTelegram('Mute state', this.filter.describe());
                return;
            }
            this.sendToTelegram('Usage', '/mute on @handle | /mute off [@handle] | /mute status');
            return;
        }

        switch (mode) {
            case 'on':
                this.filter.mute(handle);
                this.sendToTelegram('Filter', `${handle} muted.`);
                return;
            case 'off':
                this.filter.unmute(handle);
                this.sendToTelegram('Filter', `${handle} unmuted.`);
                return;
            case 'toggle': {
                const currentlyMuted = this.filter.describe().includes(handle);
                if (currentlyMuted) {
                    this.filter.unmute(handle);
                    this.sendToTelegram('Filter', `${handle} unmuted.`);
                } else {
                    this.filter.mute(handle);
                    this.sendToTelegram('Filter', `${handle} muted.`);
                }
                return;
            }
            case 'status':
                this.sendToTelegram('Mute state', this.filter.describe());
                return;
            default:
                this.sendToTelegram('Usage', '/mute [on|off|toggle|status] [@handle]');
        }
    }

    /** /focus [on|off] — unified focus control */
    private cmdFocus(raw: string): void {
        const m = raw.match(/^\/focus(?:\s+(on|off|toggle|status))?\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/focus [on|off|toggle|status]');
            return;
        }
        const mode = m[1] ?? 'toggle';
        const desc = this.filter.describe();
        const isOn = desc.includes('Focus mode: ON');
        if (mode === 'status') {
            this.sendToTelegram('Focus state', `Focus mode: ${isOn ? 'ON' : 'OFF'}`);
            return;
        }
        const next = mode === 'toggle' ? !isOn : mode === 'on';
        this.filter.setFocus(next);
        this.sendToTelegram('Filter', `Focus mode ${next ? 'ON' : 'OFF'} — ${next ? 'showing only messages that mention you or are sent to you.' : 'showing all messages.'}`);
    }

    /** /filters — display current filter state */
    private cmdFilters(): void {
        this.sendToTelegram('Active filters', this.filter.describe());
    }

    /** /wiretap [on|off|toggle|status] — unified wiretap control */
    private cmdWiretap(raw: string): void {
        const m = raw.match(/^\/wiretap(?:\s+(on|off|toggle|status))?\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/wiretap [on|off|toggle|status]');
            return;
        }
        const mode = m[1] ?? 'toggle';
        if (mode === 'status') {
            this.sendToTelegram('Wiretap', `Wiretap is ${this.wiretapMode ? 'ON' : 'OFF'}.`);
            return;
        }
        const enable = mode === 'toggle' ? !this.wiretapMode : mode === 'on';
        if (!enable && this.wiretapMode) {
            this.wiretapUnsubscribe?.();
            this.wiretapUnsubscribe = undefined;
            this.wiretapMode = false;
            this.sendToTelegram('Wiretap', 'OFF — back to normal filtered view.');
        } else if (enable && !this.wiretapMode) {
            this.wiretapMode = true;
            this.wiretapUnsubscribe = this.room.subscribeAll((msg) => {
                // Skip own messages and self-notes.
                if (msg.from === this.handle) return;
                if (msg.to === msg.from) return;
                const isAgentDm = msg.to !== '*' && msg.to !== this.handle;
                const prefix = msg.to === '*'
                    ? msg.from
                    : isAgentDm
                        ? `${msg.from} → ${msg.to} [DM]`
                        : `${msg.from} → you`;
                this.sendToTelegram(prefix, msg.text, true);
            });
            this.sendToTelegram('Wiretap', 'ON — showing all messages including agent DMs. Self-notes excluded.');
        } else {
            this.sendToTelegram('Wiretap', `Already ${this.wiretapMode ? 'ON' : 'OFF'}.`);
        }
    }

    /** /schedules [@handle] — list active reminders by agent */
    private async cmdSchedules(raw: string): Promise<void> {
        if (!this.scheduleInspector) {
            this.sendToTelegram('Schedules', 'Schedule inspector is unavailable in this runtime.');
            return;
        }
        const m = raw.match(/^\/schedules(?:\s+(@[A-Za-z0-9_-]+))?\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/schedules [@handle]');
            return;
        }
        const target = m[1];
        try {
            const rows = await this.scheduleInspector.list(target);
            if (rows.length === 0) {
                this.sendToTelegram('Schedules', target ? `No active reminders for ${target}.` : 'No active reminders.');
                return;
            }
            this.sendToTelegram('Schedules', this.formatScheduleList(rows));
        } catch (err) {
            this.sendToTelegram('Schedules', `Failed to read schedules: ${(err as Error).message}`);
        }
    }

    private formatScheduleList(rows: ScheduleReminderView[]): string {
        const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
        const cap = (value: string, width: number) =>
            value.length > width ? `${value.slice(0, Math.max(0, width - 3))}...` : value;
        const entries = rows.map(r => ({
            owner: clean(r.owner),
            type: clean(r.type),
            id: cap(clean(r.id), 56),
            schedule: cap(clean(r.schedule), 56),
            message: cap(clean(r.message), 120),
        }));
        const lines: string[] = [];
        for (const [index, r] of entries.entries()) {
            lines.push(`${index + 1}. ${r.owner} | ${r.type} | ${r.id}`);
            lines.push(`   when: ${r.schedule}`);
            lines.push(`   note: ${r.message}`);
            if (index < entries.length - 1) lines.push('');
        }
        return lines.join('\n');
    }

    /** /tools — list sandbox tools grouped by tool group */
    private cmdTools(): void {
        if (!this.sandbox) {
            this.sendToTelegram('Sandbox', 'Sandbox inspector is unavailable in this runtime.');
            return;
        }
        const grouped = new Map<string, string[]>();
        for (const t of this.sandbox.listTools()) {
            const group = t.group ?? '(legacy)';
            if (!grouped.has(group)) grouped.set(group, []);
            grouped.get(group)!.push(`${group}/${t.name}`);
        }
        const lines = [...grouped.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([group, names]) => [`**${group}**`, ...names.sort().map(n => `- ${n}`)]);
        this.sendToTelegram('Sandbox tools', lines.join('\n') || '(none)', true);
    }

    /** /ls /path — list a sandbox directory */
    private async cmdLs(raw: string): Promise<void> {
        const m = raw.match(/^\/ls\s+(\S+)\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/ls /absolute/path');
            return;
        }
        const p = m[1]!;
        if (!p.startsWith('/')) {
            this.sendToTelegram('Usage', 'Path must be absolute (start with /).');
            return;
        }
        const out = await this.runFs('ls', p);
        this.sendToTelegram(`ls ${p}`, `\`\`\`text\n${out}\n\`\`\``, true);
    }

    /** /stat /path — stat a sandbox path */
    private async cmdStat(raw: string): Promise<void> {
        const m = raw.match(/^\/stat\s+(\S+)\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/stat /absolute/path');
            return;
        }
        const p = m[1]!;
        if (!p.startsWith('/')) {
            this.sendToTelegram('Usage', 'Path must be absolute (start with /).');
            return;
        }
        const out = await this.runFs('stat', p);
        this.sendToTelegram(`stat ${p}`, `\`\`\`text\n${out}\n\`\`\``, true);
    }

    /** /tree /path [depth] — render a directory tree */
    private async cmdTree(raw: string): Promise<void> {
        const m = raw.match(/^\/tree\s+(\S+)(?:\s+(\d+))?\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/tree /absolute/path [depth]');
            return;
        }
        const p = m[1]!;
        if (!p.startsWith('/')) {
            this.sendToTelegram('Usage', 'Path must be absolute (start with /).');
            return;
        }
        try {
            const depth = m[2] ? Number(m[2]) : undefined;
            const result = await this.runTool('text/tree', depth !== undefined ? { path: p, depth } : { path: p });
            this.sendToTelegram(`tree ${p}`, `\`\`\`text\n${String(result['output'] ?? result)}\n\`\`\``, true);
        } catch (err) {
            this.sendToTelegram('tree', `Error: ${(err as Error).message}`);
        }
    }

    /** /cat /path [from to] — read a file with optional line range */
    private async cmdCat(raw: string): Promise<void> {
        const m = raw.match(/^\/cat\s+(\S+)(?:\s+(\d+))?(?:\s+(\d+))?\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/cat /absolute/path [from_line to_line]');
            return;
        }
        const p = m[1]!;
        if (!p.startsWith('/')) {
            this.sendToTelegram('Usage', 'Path must be absolute (start with /).');
            return;
        }
        try {
            const args: Record<string, unknown> = { path: p };
            if (m[2]) args['from_line'] = Number(m[2]);
            if (m[3]) args['to_line'] = Number(m[3]);
            const result = await this.runTool('text/read', args);
            const body = String(result['content'] ?? '');
            this.sendToTelegram(`cat ${p}`, `\`\`\`text\n${body}\n\`\`\``, true);
        } catch (err) {
            this.sendToTelegram('cat', `Error: ${(err as Error).message}`);
        }
    }

    /** /md <path-or-query> — read markdown file by absolute path or fuzzy filename/path match */
    private async cmdMarkdown(raw: string): Promise<void> {
        const m = raw.match(/^\/md\s+(.+?)\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/md <absolute-path-or-query>');
            return;
        }
        const input = m[1]!.trim();
        try {
            if (input.startsWith('/')) {
                if (!input.endsWith('.md')) {
                    this.sendToTelegram('md', 'Path must end with .md');
                    return;
                }
                await this.sendMarkdownFile(input);
                return;
            }

            const matches = await this.findMarkdownByQuery(input);
            if (matches.length === 0) {
                this.sendToTelegram('md', `No markdown files matched "${input}".`);
                return;
            }

            const [best, second] = matches;
            const confident = !second || best.score >= second.score + 6;
            if (!confident) {
                const shortlist = matches.slice(0, 5).map(m2 => `- ${m2.path}`).join('\n');
                this.sendToTelegram(
                    'md matches',
                    `Multiple close matches for "${input}":\n${shortlist}\nUse /md <full-path> or /cat <full-path>.`,
                    true,
                );
                return;
            }

            await this.sendMarkdownFile(best.path);
        } catch (err) {
            this.sendToTelegram('md', `Error: ${(err as Error).message}`);
        }
    }

    private async cmdMarkdownRaw(raw: string): Promise<void> {
        const m = raw.match(/^\/mdraw\s+(\S+)\s*$/);
        if (!m) {
            this.sendToTelegram('Usage', '/mdraw /absolute/path.md');
            return;
        }
        const input = m[1]!.trim();
        try {
            if (!input.startsWith('/')) {
                this.sendToTelegram('Usage', 'Path must be absolute (start with /).');
                return;
            }
            if (!input.endsWith('.md')) {
                this.sendToTelegram('mdraw', 'Path must end with .md');
                return;
            }
            await this.sendMarkdownFileRaw(input);
        } catch (err) {
            this.sendToTelegram('mdraw', `Error: ${(err as Error).message}`);
        }
    }

    private async runFs(op: 'ls' | 'stat', path: string): Promise<string> {
        if (!this.sandbox) {
            return 'Error: Sandbox inspector is unavailable in this runtime.';
        }
        try {
            const raw = await this.sandbox.execFs({ type: 'fs', op, path }, this.handle);
            return this.stripActionPrefix(raw);
        } catch (err) {
            return `Error: ${(err as Error).message}`;
        }
    }

    private async runTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!this.sandbox) {
            throw new Error('Sandbox inspector is unavailable in this runtime.');
        }
        const raw = await this.sandbox.execCall(tool, args, this.handle);
        const i = raw.indexOf(' → ');
        if (i === -1) throw new Error(`Unexpected tool response format: ${raw}`);
        return JSON.parse(raw.slice(i + 3)) as Record<string, unknown>;
    }

    private stripActionPrefix(raw: string): string {
        const i = raw.indexOf('→');
        return i === -1 ? raw : raw.slice(i + 1).trim();
    }

    private async sendMarkdownFile(path: string): Promise<void> {
        const body = await this.readRawFile(path);
        const rendered = this.truncateForTelegram(body);
        this.sendToTelegram(`md ${path}`, rendered, true);
    }

    private async sendMarkdownFileRaw(path: string): Promise<void> {
        const body = await this.readRawFile(path);
        this.sendToTelegram(`mdraw ${path}`, body, false);
    }

    private async findMarkdownByQuery(query: string): Promise<Array<{ path: string; score: number }>> {
        const roots = ['/home', '/data'];
        const allPaths = new Set<string>();
        for (const root of roots) {
            try {
                const r = await this.runTool('text/find', { path: root, pattern: '*.md', type: 'f' });
                const rows = Array.isArray(r['results']) ? r['results'] as Array<Record<string, unknown>> : [];
                for (const row of rows) {
                    const p = String(row['path'] ?? '');
                    if (p.endsWith('.md')) allPaths.add(p);
                }
            } catch {
                // Root may be absent/empty in some runtimes.
            }
        }
        const q = query.toLowerCase();
        const scored = [...allPaths]
            .map(p => ({ path: p, score: this.fuzzyScore(q, p.toLowerCase()) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
        return scored;
    }

    private fuzzyScore(query: string, targetPath: string): number {
        const base = targetPath.split('/').pop() ?? targetPath;
        if (base === query || targetPath === query) return 100;
        if (base.includes(query)) return 80 - Math.max(0, base.length - query.length);
        if (targetPath.includes(query)) return 60 - Math.max(0, targetPath.length - query.length) / 4;

        let qi = 0;
        let spans = 0;
        for (let i = 0; i < targetPath.length && qi < query.length; i++) {
            if (targetPath[i] === query[qi]) {
                qi++;
                spans++;
            }
        }
        if (qi !== query.length) return 0;
        return 20 + Math.min(20, spans);
    }

    private async readRawFile(path: string): Promise<string> {
        if (!this.sandbox) throw new Error('Sandbox inspector is unavailable in this runtime.');
        const raw = await this.sandbox.execFs({ type: 'fs', op: 'read', path }, this.handle);
        // fs:read /path →\n<content>
        const marker = '→\n';
        const i = raw.indexOf(marker);
        return i === -1 ? raw : raw.slice(i + marker.length);
    }

    private truncateForTelegram(message: string): string {
        if (message.length <= TelegramParticipant.TELEGRAM_MAX_CHARS) return message;
        return message.slice(0, TelegramParticipant.TELEGRAM_MAX_CHARS) + '\n\n[truncated]';
    }

    // ─── Transport ───────────────────────────────────────────────

    private sendToTelegram(title: string, message: string, markdown = false): void {
        const safeMessage = this.truncateForTelegram(message);
        this.events.emit('notification:send', { title, message: safeMessage, markdown }).catch(err => {
            // Markdown parsers can reject strict/invalid markup (provider-dependent parse mode).
            // Retry once as plain text so operators still receive the content.
            if (markdown) {
                this.events.emit('notification:send', { title, message: safeMessage, markdown: false }).catch(err2 => {
                    this.logger?.error('Failed to send to Telegram', { error: (err2 as Error).message });
                });
                return;
            }
            this.logger?.error('Failed to send to Telegram', { error: (err as Error).message });
        });
    }
}
