/**
 * ViewFilter — controls which room messages are forwarded to the Telegram operator.
 *
 * Owned by TelegramParticipant. Applies two independent filters:
 *
 *  Focus mode  — when ON, only messages that mention the operator's handle
 *                or are addressed directly to them are forwarded.
 *  Mute list   — messages from muted handles are always suppressed,
 *                even when the muted sender mentions the operator.
 *
 * Both filters are stateful and toggled via slash commands at runtime.
 */

import type { Message } from './types.js';

export class ViewFilter {
    private focusMode = false;
    private muted = new Set<string>();

    /**
     * Returns true if the message should be forwarded to the operator.
     *
     * @param message     The room message to evaluate.
     * @param selfHandle  The operator's handle (e.g. '@architect').
     */
    allows(message: Message, selfHandle: string): boolean {
        if (this.muted.has(message.from)) return false;
        if (this.focusMode) {
            return message.text.includes(selfHandle) || message.to === selfHandle;
        }
        return true;
    }

    /** Suppress all future messages from this handle. */
    mute(handle: string): void {
        this.muted.add(handle);
    }

    /**
     * Restore a muted handle, or clear all mutes when called without an argument.
     *
     * @param handle  Handle to unmute. Omit to clear all mutes.
     */
    unmute(handle?: string): void {
        if (handle === undefined) {
            this.muted.clear();
        } else {
            this.muted.delete(handle);
        }
    }

    /** Enable or disable focus mode. */
    setFocus(on: boolean): void {
        this.focusMode = on;
    }

    /** Returns true if this exact handle is currently muted. */
    isMuted(handle: string): boolean {
        return this.muted.has(handle);
    }

    /** Human-readable summary of current filter state, used by /filters command. */
    describe(): string {
        const focus = `Focus mode: ${this.focusMode ? 'ON' : 'OFF'}`;
        const muted = this.muted.size > 0
            ? `Muted: ${[...this.muted].sort().join(', ')}`
            : 'Muted: none';
        return `${focus}\n${muted}`;
    }
}
