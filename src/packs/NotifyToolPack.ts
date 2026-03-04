/**
 * NotifyToolPack — send notifications from sandbox agents.
 *
 * Mounts at /tools/notify/ via ToolGroupPack.
 *
 * Tools:
 *   notify/slack    — Send a Slack notification via the notifications bundle.
 *   notify/telegram — Send a Telegram notification via the notifications bundle.
 *
 * Both tools emit the corresponding event on the IEventBus, which the
 * notifications bundle handles. Slack requires SLACK_WEBHOOK_URL to be
 * configured; Telegram requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 */

import type { IEventBus } from '@nucleic-se/gears';
import type { SandboxLayer } from '../sandbox/layer.js';
import { ToolGroupPack } from '../sandbox/ToolGroupPack.js';
import type { Tool } from '../sandbox/ToolGroupPack.js';
import { requireString } from './pack-helpers.js';

export class NotifyToolPack {
    constructor(private events: IEventBus) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('notify', [
            this.slackTool(),
            this.telegramTool(),
        ]).createLayer();
    }

    private slackTool(): Tool {
        const { events } = this;
        return {
            name: 'slack',
            description: 'Send a Slack notification. Requires SLACK_WEBHOOK_URL to be configured.',
            parameters: {
                title:    { type: 'string',  description: 'Short heading for the notification', required: true },
                message:  { type: 'string',  description: 'Body text (standard Markdown supported)', required: true },
                markdown: { type: 'boolean', description: 'Set true if message contains Markdown formatting (default: false)', required: false },
            },
            async handler(args) {
                const title   = requireString(args, 'title');
                const message = requireString(args, 'message');
                const markdown = args['markdown'] === true;
                await events.emit('notification:slack', { title, message, markdown });
                return { sent: true, channel: 'slack' };
            },
        };
    }

    private telegramTool(): Tool {
        const { events } = this;
        return {
            name: 'telegram',
            description: 'Send a Telegram notification. Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be configured.',
            parameters: {
                title:    { type: 'string',  description: 'Short heading for the notification', required: true },
                message:  { type: 'string',  description: 'Body text (standard Markdown supported)', required: true },
                markdown: { type: 'boolean', description: 'Set true if message contains Markdown formatting (default: false)', required: false },
            },
            async handler(args) {
                const title   = requireString(args, 'title');
                const message = requireString(args, 'message');
                const markdown = args['markdown'] === true;
                await events.emit('notification:telegram', { title, message, markdown });
                return { sent: true, channel: 'telegram' };
            },
        };
    }
}
