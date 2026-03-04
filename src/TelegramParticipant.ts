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
 *   /mute @handle         — suppress messages from a handle
 *   /unmute @handle       — restore a muted handle
 *   /unmute               — clear all mutes
 *   /focus                — show only messages that mention you or are sent to you
 *   /unfocus              — show all messages (default)
 *   /filters              — display current filter state
 *   /wiretap              — toggle unfiltered view of all messages including agent DMs
 */

import type { IEventBus } from '@nucleic-se/gears';
import type { ILogger } from '@nucleic-se/gears';
import type { Message, Participant } from './types.js';
import type { Room } from './Room.js';
import { ViewFilter } from './ViewFilter.js';

interface Command {
    description: string;
    handler: (raw: string) => void;
}

export interface TelegramParticipantConfig {
    handle: string;
    displayName: string;
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

    constructor(config: TelegramParticipantConfig, room: Room, events: IEventBus, logger?: ILogger) {
        this.handle = config.handle;
        this.displayName = config.displayName;
        this.room = room;
        this.events = events;
        this.logger = logger;
        this.commands = new Map([
            ['help',    { description: 'List all available commands', handler: () => this.cmdHelp() }],
            ['dm',      { description: 'Send a direct message: /dm @handle message', handler: (raw: string) => this.cmdDm(raw) }],
            ['who',     { description: 'List participants in the room', handler: () => this.cmdWho() }],
            ['mute',    { description: 'Suppress messages from a handle: /mute @handle', handler: (raw: string) => this.cmdMute(raw) }],
            ['unmute',  { description: 'Restore a muted handle, or clear all mutes: /unmute [@handle]', handler: (raw: string) => this.cmdUnmute(raw) }],
            ['focus',   { description: 'Show only messages that mention you or are sent to you', handler: () => this.cmdFocus() }],
            ['unfocus', { description: 'Show all messages (default)', handler: () => this.cmdUnfocus() }],
            ['filters', { description: 'Display current filter state', handler: () => this.cmdFilters() }],
            ['wiretap', { description: 'Toggle unfiltered view of all messages including agent DMs (notes excluded)', handler: () => this.cmdWiretap() }],
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
        const match = raw.match(/^\/dm\s+(@\w+)\s+(.+)$/s);
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

    /** /mute @handle — suppress messages from a handle */
    private cmdMute(raw: string): void {
        const match = raw.match(/^\/mute\s+(@\w+)$/);
        if (!match) {
            this.sendToTelegram('Usage', '/mute @handle');
            return;
        }
        this.filter.mute(match[1]);
        this.sendToTelegram('Filter', `${match[1]} muted.`);
    }

    /** /unmute @handle — restore a muted handle; /unmute — clear all mutes */
    private cmdUnmute(raw: string): void {
        const match = raw.match(/^\/unmute\s+(@\w+)$/);
        if (match) {
            this.filter.unmute(match[1]);
            this.sendToTelegram('Filter', `${match[1]} unmuted.`);
        } else {
            this.filter.unmute();
            this.sendToTelegram('Filter', 'All mutes cleared.');
        }
    }

    /** /focus — show only messages mentioning you or sent to you */
    private cmdFocus(): void {
        this.filter.setFocus(true);
        this.sendToTelegram('Filter', 'Focus mode ON — showing only messages that mention you or are sent to you.');
    }

    /** /unfocus — show all messages */
    private cmdUnfocus(): void {
        this.filter.setFocus(false);
        this.sendToTelegram('Filter', 'Focus mode OFF — showing all messages.');
    }

    /** /filters — display current filter state */
    private cmdFilters(): void {
        this.sendToTelegram('Active filters', this.filter.describe());
    }

    /** /wiretap — toggle unfiltered view of all room messages including agent DMs */
    private cmdWiretap(): void {
        if (this.wiretapMode) {
            this.wiretapUnsubscribe?.();
            this.wiretapUnsubscribe = undefined;
            this.wiretapMode = false;
            this.sendToTelegram('Wiretap', 'OFF — back to normal filtered view.');
        } else {
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
        }
    }

    // ─── Transport ───────────────────────────────────────────────

    private sendToTelegram(title: string, message: string, markdown = false): void {
        this.events.emit('notification:send', { title, message, markdown }).catch(err => {
            this.logger?.error('Failed to send to Telegram', { error: (err as Error).message });
        });
    }
}
