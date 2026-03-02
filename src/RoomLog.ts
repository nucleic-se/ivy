/**
 * RoomLog — SQLite-backed ordered event log.
 *
 * Persists every message (broadcast and private) in a single table.
 * Provides filtered reads so each participant only sees messages
 * visible to them.
 */

import { randomUUID } from 'node:crypto';
import type { Message } from './types.js';

/**
 * Minimal subset of better-sqlite3 Database used by RoomLog.
 * Avoids importing better-sqlite3 directly — the real instance
 * comes from gears' SharedDatabase.
 */
interface Database {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...params: any[]): any;
        all(...params: any[]): any[];
        get(...params: any[]): any;
    };
}

export class RoomLog {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ivy_messages (
                id         TEXT PRIMARY KEY,
                "from"     TEXT NOT NULL,
                "to"       TEXT NOT NULL DEFAULT '*',
                text       TEXT NOT NULL,
                timestamp  INTEGER NOT NULL
            )
        `);
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ivy_messages_ts ON ivy_messages(timestamp)
        `);
    }

    /** Append a message to the log. Returns the persisted message. */
    append(from: string, to: string, text: string): Message {
        const msg: Message = {
            id: randomUUID(),
            from,
            to,
            text,
            timestamp: Date.now(),
        };
        this.db.prepare(
            `INSERT INTO ivy_messages (id, "from", "to", text, timestamp) VALUES (?, ?, ?, ?, ?)`
        ).run(msg.id, msg.from, msg.to, msg.text, msg.timestamp);
        return msg;
    }

    /**
     * Get recent messages visible to a given participant handle.
     * A message is visible if: to='*' OR to=handle OR from=handle.
     */
    getVisibleTo(handle: string, limit: number = 50): Message[] {
        return this.db.prepare(`
            SELECT id, "from", "to", text, timestamp
            FROM ivy_messages
            WHERE "to" = '*' OR "to" = ? OR "from" = ?
            ORDER BY timestamp DESC, rowid DESC
            LIMIT ?
        `).all(handle, handle, limit).reverse() as Message[];
    }

    /** Get the full unfiltered log (most recent N). */
    getAll(limit: number = 100): Message[] {
        return this.db.prepare(`
            SELECT id, "from", "to", text, timestamp
            FROM ivy_messages
            ORDER BY timestamp DESC, rowid DESC
            LIMIT ?
        `).all(limit).reverse() as Message[];
    }

    /** Get recent public (broadcast) messages visible to everyone. */
    getPublic(limit: number = 50): Message[] {
        return this.db.prepare(`
            SELECT id, "from", "to", text, timestamp
            FROM ivy_messages
            WHERE "to" = '*'
            ORDER BY timestamp DESC, rowid DESC
            LIMIT ?
        `).all(limit).reverse() as Message[];
    }

    /**
     * Get recent private messages involving a participant.
     * Excludes self-to-self internal notes (from = to).
     */
    getPrivate(handle: string, limit: number = 20): Message[] {
        return this.db.prepare(`
            SELECT id, "from", "to", text, timestamp
            FROM ivy_messages
            WHERE "to" != '*' AND "to" != "from" AND ("to" = ? OR "from" = ?)
            ORDER BY timestamp DESC, rowid DESC
            LIMIT ?
        `).all(handle, handle, limit).reverse() as Message[];
    }

    /**
     * Get recent internal self-notes for a participant (from = to = handle).
     */
    getInternal(handle: string, limit: number = 20): Message[] {
        return this.db.prepare(`
            SELECT id, "from", "to", text, timestamp
            FROM ivy_messages
            WHERE "to" = "from" AND "from" = ?
            ORDER BY timestamp DESC, rowid DESC
            LIMIT ?
        `).all(handle, limit).reverse() as Message[];
    }

    /** Total message count. */
    count(): number {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ivy_messages`).get() as { cnt: number };
        return row.cnt;
    }
}
