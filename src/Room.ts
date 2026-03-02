/**
 * Room — the shared message bus.
 *
 * Delegates persistence to RoomLog (SQLite). Delivers messages
 * to participants filtered by visibility (broadcast vs private).
 */

import type { ILogger } from 'gears';
import type { Message, Participant } from './types.js';
import { isVisibleTo } from './types.js';
import type { RoomLog } from './RoomLog.js';

export class Room {
    private participants: Map<string, Participant> = new Map();

    constructor(private log: RoomLog, private logger?: ILogger) {}

    /** Register a participant. */
    join(participant: Participant): void {
        if (this.participants.has(participant.handle)) {
            throw new Error(`Participant ${participant.handle} already in room`);
        }
        this.participants.set(participant.handle, participant);
        this.logger?.info(`${participant.displayName} joined the room`, { handle: participant.handle });
    }

    /** Remove a participant from the room. */
    leave(handle: string): void {
        if (!this.participants.has(handle)) {
            throw new Error(`Participant ${handle} is not in the room`);
        }
        this.participants.delete(handle);
        this.logger?.info(`${handle} left the room`);
    }

    /** Check whether a handle is a joined participant. */
    hasParticipant(handle: string): boolean {
        return this.participants.has(handle);
    }

    /** Post a broadcast message (visible to everyone). */
    post(from: string, text: string): Message {
        this.assertMember(from);
        return this.send(from, '*', text);
    }

    /** Send a private message (visible only to sender and recipient). */
    dm(from: string, to: string, text: string): Message {
        this.assertMember(from);
        if (!this.participants.has(to)) {
            this.logger?.warn(`dm target ${to} is not in the room — message dropped`, { from });
            // Still persist for audit, but warn loudly.
        }
        return this.send(from, to, text);
    }

    /** Store an internal self-note (visible only to sender in history reads). */
    note(from: string, text: string): Message {
        this.assertMember(from);
        return this.send(from, from, text);
    }

    /** Core send: persists to log, then notifies visible participants. */
    private send(from: string, to: string, text: string): Message {
        const msg = this.log.append(from, to, text);

        const label = to === '*' ? `[${from}]` : `[${from} → ${to}]`;
        this.logger?.info(`${label} ${text}`);

        // Notify participants who can see this message (excluding sender).
        for (const [handle, participant] of this.participants) {
            if (handle !== from && isVisibleTo(msg, handle)) {
                participant.receive(msg);
            }
        }

        return msg;
    }

    /** Get recent messages visible to a specific participant. */
    getVisibleTo(handle: string, limit?: number): Message[] {
        return this.log.getVisibleTo(handle, limit);
    }

    /** Get recent public (broadcast) messages. */
    getPublic(limit?: number): Message[] {
        return this.log.getPublic(limit);
    }

    /** Get recent private messages involving a participant. */
    getPrivate(handle: string, limit?: number): Message[] {
        return this.log.getPrivate(handle, limit);
    }

    /** Get recent internal self-notes for a participant. */
    getInternal(handle: string, limit?: number): Message[] {
        return this.log.getInternal(handle, limit);
    }

    /** Get full unfiltered log (for admin/debug). */
    getAll(limit?: number): Message[] {
        return this.log.getAll(limit);
    }

    /** List all participants in the room. */
    getParticipants(): { handle: string; displayName: string }[] {
        return [...this.participants.values()].map(p => ({
            handle: p.handle,
            displayName: p.displayName,
        }));
    }

    /** Throws if `handle` is not a joined participant. */
    private assertMember(handle: string): void {
        if (!this.participants.has(handle)) {
            throw new Error(`Sender ${handle} is not a participant in the room`);
        }
    }
}
