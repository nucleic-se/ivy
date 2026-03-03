/**
 * HistoryToolPack — room history query tools for sandbox agents.
 *
 * Mounts at /tools/history/ via ToolGroupPack.
 *
 * Privacy model:
 *   - history/view  type=public   → broadcast messages (visible to all)
 *   - history/view  type=private  → only DMs where callerHandle is sender or recipient
 *   - history/view  type=internal → only callerHandle's self-notes and tool results
 *   - history/search type=public  → public messages only
 *   - history/search type=private → caller's DMs only
 *   - history/search type=all     → public + caller's DMs (no internal)
 *
 * Tools never expose messages the caller could not see in the room directly.
 *
 * Tools:
 *   history/view   — paginated view of a message bucket, optionally filtered
 *   history/search — text search across visible history
 */

import type { Message } from '../types.js';
import type { Room } from '../Room.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { ToolGroupPack } from '../sandbox/ToolGroupPack.js';
import type { Tool } from '../sandbox/ToolGroupPack.js';

// Maximum messages fetched from the log per query — sufficient for any practical
// chat history while keeping in-memory filtering cheap.
const VIEW_FETCH  = 500;
const SEARCH_FETCH = 1_000;

type ViewType   = 'public' | 'private' | 'internal';
type SearchType = 'public' | 'private' | 'all';

export class HistoryToolPack {
    constructor(private room: Room) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('history', [
            this.viewTool(),
            this.searchTool(),
        ]).createLayer();
    }

    // ── history/view ────────────────────────────────────────────

    private viewTool(): Tool {
        const { room } = this;
        return {
            name: 'view',
            description: [
                'View paginated room message history.',
                'type=public: broadcast messages (visible to all).',
                'type=private: DMs you sent or received only.',
                'type=internal: your self-notes and tool results only.',
                'Use before= with an ISO timestamp to page back further in time.',
            ].join(' '),
            parameters: {
                type:   { type: 'string',  description: '"public" (default), "private", or "internal"', required: false },
                limit:  { type: 'number',  description: 'Messages to return (default 50, max 200)', required: false },
                before: { type: 'string',  description: 'Return only messages before this ISO timestamp (pagination cursor)', required: false },
                from:   { type: 'string',  description: 'Filter by sender handle', required: false },
            },
            returns: '{ messages: [{timestamp, from, to?, text}], total, has_more }',
            handler: async (args, callerHandle) => {
                const type   = parseViewType(args['type']);
                const limit  = parseLimit(args['limit'], 50, 200);
                const before = parseBefore(args['before']);
                const from   = parseHandle(args['from']);

                let messages: Message[];
                switch (type) {
                    case 'public':   messages = room.getPublic(VIEW_FETCH); break;
                    case 'private':  messages = room.getPrivate(callerHandle!, VIEW_FETCH); break;
                    case 'internal': messages = room.getInternal(callerHandle!, VIEW_FETCH); break;
                }

                if (before !== null)  messages = messages.filter(m => m.timestamp < before);
                if (from   !== null)  messages = messages.filter(m => m.from === from);

                const total    = messages.length;
                const slice    = messages.slice(-limit); // most recent N
                const has_more = total > limit;

                return { messages: slice.map(fmt), total, has_more };
            },
        };
    }

    // ── history/search ──────────────────────────────────────────

    private searchTool(): Tool {
        const { room } = this;
        return {
            name: 'search',
            description: [
                'Search room message history by text (case-insensitive substring).',
                'type=public: public messages only (default).',
                'type=private: your DMs only.',
                'type=all: public + your DMs (no internal notes).',
                'Results are ordered oldest-first within the match set.',
            ].join(' '),
            parameters: {
                query:  { type: 'string',  description: 'Text to search for', required: true },
                type:   { type: 'string',  description: '"public" (default), "private", or "all"', required: false },
                from:   { type: 'string',  description: 'Filter by sender handle', required: false },
                limit:  { type: 'number',  description: 'Max results (default 20, max 50)', required: false },
            },
            returns: '{ matches: [{timestamp, from, to?, text}], count, truncated }',
            handler: async (args, callerHandle) => {
                const query = requireString(args, 'query').toLowerCase();
                const type  = parseSearchType(args['type']);
                const limit = parseLimit(args['limit'], 20, 50);
                const from  = parseHandle(args['from']);

                let messages: Message[];
                switch (type) {
                    case 'public':
                        messages = room.getPublic(SEARCH_FETCH);
                        break;
                    case 'private':
                        messages = room.getPrivate(callerHandle!, SEARCH_FETCH);
                        break;
                    case 'all':
                        // Public + private DMs — exclude internal notes (from===to).
                        messages = room.getVisibleTo(callerHandle!, SEARCH_FETCH)
                            .filter(m => !(m.from === callerHandle && m.to === callerHandle));
                        break;
                }

                if (from !== null) messages = messages.filter(m => m.from === from);
                messages = messages.filter(m => m.text.toLowerCase().includes(query));

                const count     = messages.length;
                const truncated = count > limit;
                const slice     = messages.slice(-limit); // most recent matches

                return { matches: slice.map(fmt), count, truncated };
            },
        };
    }
}

// ── Helpers ──────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" must be a non-empty string`);
    return v.trim();
}

function parseViewType(raw: unknown): ViewType {
    if (raw === 'private' || raw === 'internal') return raw;
    return 'public';
}

function parseSearchType(raw: unknown): SearchType {
    if (raw === 'private' || raw === 'all') return raw;
    return 'public';
}

function parseLimit(raw: unknown, def: number, max: number): number {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}

function parseBefore(raw: unknown): number | null {
    if (raw == null) return null;
    const ts = typeof raw === 'number' ? raw : Date.parse(String(raw));
    return isFinite(ts) ? ts : null;
}

function parseHandle(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return raw.trim();
}

/** Serialize a Message for tool output — omits `to` for broadcast and self-notes. */
function fmt(m: Message): Record<string, unknown> {
    const base: Record<string, unknown> = {
        timestamp: new Date(m.timestamp).toISOString(),
        from: m.from,
        text: m.text,
    };
    // Include `to` only for DMs — not for broadcast ('*') or self-notes (from===to).
    if (m.to !== '*' && m.to !== m.from) {
        base['to'] = m.to;
    }
    return base;
}
