/**
 * TelegramParticipant — bridges Telegram into the chatroom via the
 * gears notifications bundle.
 *
 * Inbound:  listens for 'notification:receive' events on IEventBus
 *           and posts them to the room as the human.
 * Outbound: subscribes to room messages (via receive()) and sends
 *           non-self messages to Telegram via 'notification:send'.
 */

import type { IEventBus } from 'gears';
import type { ILogger } from 'gears';
import type { Message, Participant } from './types.js';
import type { Room } from './Room.js';

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

    constructor(config: TelegramParticipantConfig, room: Room, events: IEventBus, logger?: ILogger) {
        this.handle = config.handle;
        this.displayName = config.displayName;
        this.room = room;
        this.events = events;
        this.logger = logger;
    }

    /** Called by the room when a visible message is posted. Forward to Telegram. */
    receive(message: Message): void {
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

    /** Stop listening. */
    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    // ─── Slash Commands ─────────────────────────────────────────

    private handleCommand(key: string, raw: string): void {
        switch (key) {
            case 'pm': return this.cmdPm(raw);
            case 'who': return this.cmdWho();
            default:
                this.sendToTelegram('Unknown command', `/${key} is not recognized. Use /pm or /who.`);
        }
    }

    /** /pm @handle message — send a private message */
    private cmdPm(raw: string): void {
        // Expected: "/pm @handle some message text"
        const match = raw.match(/^\/pm\s+(@\w+)\s+(.+)$/s);
        if (!match) {
            this.sendToTelegram('Usage', '/pm @handle message');
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
        this.sendToTelegram('Participants', list || 'No one is here.');
    }

    private sendToTelegram(title: string, message: string, markdown = false): void {
        this.events.emit('notification:send', { title, message, markdown }).catch(err => {
            this.logger?.error('Failed to send to Telegram', { error: (err as Error).message });
        });
    }
}
