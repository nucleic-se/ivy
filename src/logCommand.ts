/**
 * ivy log — CLI command for analysing the ivy room message log.
 *
 * Usage:
 *   gears ivy log
 *   gears ivy log --tail 50
 *   gears ivy log --since 2026-02-01
 *
 * Reads the ivy_messages table in shared.sqlite directly (read-only).
 * Safe to run while the worker is live — uses a separate SQLite connection.
 */

import type { CommandDefinition } from '@nucleic-se/gears';

// ── Types ─────────────────────────────────────────────────────────

interface MsgRow {
    from: string;
    to: string;
    text: string;
    timestamp: number;
}

// ── Formatting helpers ────────────────────────────────────────────

function bar(fraction: number, width = 20): string {
    const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pct(n: number, total: number): string {
    if (total === 0) return '  0%';
    return `${Math.round((n / total) * 100).toString().padStart(3)}%`;
}

function isoDate(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

function isoTime(ts: number): string {
    return new Date(ts).toISOString().slice(11, 19);
}

function handle(h: string): string {
    return h.startsWith('@') ? h : `@${h}`;
}

// ── Command ───────────────────────────────────────────────────────

export const logCommand: CommandDefinition = {
    name: 'log',
    description: 'Analyse the ivy room message log and print a full activity breakdown.',
    options: [
        {
            flags: '--tail <n>',
            description: 'Number of recent public messages to show in the timeline (default: 30)',
            default: '30',
        },
        {
            flags: '--since <date>',
            description: 'Only include messages on or after this date (YYYY-MM-DD)',
            default: '',
        },
        {
            flags: '--dm',
            description: 'Show recent private DMs in the timeline instead of public messages',
        },
    ],

    action: async (args, app, output) => {
        const io = output ?? {
            log: (message: string) => console.log(message),
            error: (message: string) => console.error(message),
        };
        // ── Database access ───────────────────────────────────────
        const shared = app.make('SharedDatabase') as { db: any };
        const db = shared.db;

        const tableExists = db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name='ivy_messages'`
        ).get();

        if (!tableExists) {
            io.log('No ivy_messages table found — the room has not been used yet.');
            return;
        }

        // ── Build WHERE clause ────────────────────────────────────
        let where = '';
        const params: unknown[] = [];
        const sinceArg = String(args['since'] ?? '').trim();
        if (sinceArg) {
            const sinceMs = new Date(sinceArg).getTime();
            if (isNaN(sinceMs)) {
                io.error(`Invalid --since date: "${sinceArg}". Use YYYY-MM-DD.`);
                return;
            }
            where = 'WHERE timestamp >= ?';
            params.push(sinceMs);
        }

        // ── Fetch all rows ────────────────────────────────────────
        const rows: MsgRow[] = db.prepare(
            `SELECT "from", "to", text, timestamp
             FROM ivy_messages
             ${where}
             ORDER BY timestamp ASC, rowid ASC`
        ).all(...params);

        const total = rows.length;
        if (total === 0) {
            io.log('No messages found' + (sinceArg ? ` since ${sinceArg}` : '') + '.');
            return;
        }

        const first = rows[0]!;
        const last  = rows[total - 1]!;
        const span  = `${isoDate(first.timestamp)} → ${isoDate(last.timestamp)}`;
        const sinceNote = sinceArg ? ` (since ${sinceArg})` : '';

        const SEP  = '═'.repeat(64);
        const sep  = '─'.repeat(64);
        const sec  = (title: string) =>
            `── ${title} ${'─'.repeat(Math.max(0, 62 - title.length - 3))}`;

        // ── Header ────────────────────────────────────────────────
        io.log('');
        io.log(SEP);
        io.log(` IVY MESSAGE LOG  ${total.toLocaleString()} messages${sinceNote}`);
        io.log(` Span: ${span}`);
        io.log(SEP);

        // ── Volume by type ────────────────────────────────────────
        const pub  = rows.filter(r => r.to === '*');
        const priv = rows.filter(r => r.to !== '*' && r.to !== r.from);
        const self = rows.filter(r => r.to === r.from);

        io.log('');
        io.log(sec('VOLUME BY TYPE'));
        const typeRows: [string, number][] = [
            ['Public (broadcast)', pub.length],
            ['Private (DM)',       priv.length],
            ['Internal (notes)',   self.length],
        ];
        for (const [label, n] of typeRows) {
            io.log(
                `  ${label.padEnd(22)} ${bar(n / total)}  ${String(n).padStart(5)}  ${pct(n, total)}`
            );
        }

        // ── By sender ─────────────────────────────────────────────
        const bySender = new Map<string, number>();
        for (const r of rows) bySender.set(r.from, (bySender.get(r.from) ?? 0) + 1);
        const senders = [...bySender.entries()].sort((a, b) => b[1] - a[1]);

        io.log('');
        io.log(sec('MESSAGES BY SENDER'));
        for (const [sender, n] of senders) {
            io.log(
                `  ${handle(sender).padEnd(18)} ${bar(n / total)}  ${String(n).padStart(5)}  ${pct(n, total)}`
            );
        }

        // ── Tool call stats ───────────────────────────────────────
        const toolCallRe = /\[call:\s*\{|"tool"\s*:|tool_use|<tool_call>/i;
        const toolResultRe = /\[result:|tool_result|<tool_response>/i;
        const callCount   = rows.filter(r => toolCallRe.test(r.text)).length;
        const resultCount = rows.filter(r => toolResultRe.test(r.text)).length;
        if (callCount > 0 || resultCount > 0) {
            io.log('');
            io.log(sec('TOOL ACTIVITY'));
            io.log(`  Tool calls   ${String(callCount).padStart(6)}`);
            io.log(`  Tool results ${String(resultCount).padStart(6)}`);
        }

        // ── Private DM pairs ──────────────────────────────────────
        const dmPairs = new Map<string, number>();
        for (const r of priv) {
            const key = [r.from, r.to].sort().join(' ↔ ');
            dmPairs.set(key, (dmPairs.get(key) ?? 0) + 1);
        }
        const pairs = [...dmPairs.entries()].sort((a, b) => b[1] - a[1]);

        if (pairs.length > 0) {
            io.log('');
            io.log(sec('PRIVATE DM PAIRS'));
            for (const [pair, n] of pairs) {
                const label = pair.split(' ↔ ').map(handle).join(' ↔ ');
                io.log(`  ${label.padEnd(36)} ${String(n).padStart(5)} msgs`);
            }
        }

        // ── Daily activity ────────────────────────────────────────
        const byDay = new Map<string, number>();
        for (const r of rows) {
            const d = isoDate(r.timestamp);
            byDay.set(d, (byDay.get(d) ?? 0) + 1);
        }
        const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const recentDays = days.slice(-14);
        const maxDay = Math.max(...recentDays.map(d => d[1]), 1);
        const suffix = days.length > 14 ? ` — last 14 of ${days.length} active days` : '';

        io.log('');
        io.log(sec(`DAILY ACTIVITY${suffix}`));
        for (const [day, n] of recentDays) {
            io.log(`  ${day}  ${bar(n / maxDay, 28)}  ${String(n).padStart(4)}`);
        }

        // ── Hourly heatmap (all data) ─────────────────────────────
        const byHour = new Array<number>(24).fill(0);
        for (const r of rows) byHour[new Date(r.timestamp).getUTCHours()]! += 1;
        const maxHour = Math.max(...byHour, 1);

        io.log('');
        io.log(sec('HOURLY HEATMAP (UTC)'));
        // Two rows: 00-11, 12-23
        for (let startH = 0; startH < 24; startH += 12) {
            const labels = Array.from({ length: 12 }, (_, i) => String(startH + i).padStart(2, '0'));
            const blocks = Array.from({ length: 12 }, (_, i) => {
                const frac = byHour[startH + i]! / maxHour;
                if (frac === 0) return '·';
                if (frac < 0.25) return '▁';
                if (frac < 0.5)  return '▄';
                if (frac < 0.75) return '▆';
                return '█';
            });
            io.log(`  ${labels.join('  ')} h`);
            io.log(`  ${blocks.join('  ')} `);
        }

        // ── Timeline ──────────────────────────────────────────────
        const tailN = Math.max(1, parseInt(String(args['tail'] ?? '30'), 10) || 30);
        const showDm = Boolean(args['dm']);
        const source = showDm ? priv : pub;
        const slice  = source.slice(-tailN);
        const tlLabel = showDm ? 'RECENT PRIVATE DMs' : 'RECENT PUBLIC MESSAGES';

        io.log('');
        io.log(sec(`${tlLabel} — last ${slice.length}`));
        if (slice.length === 0) {
            io.log('  (none)');
        } else {
            for (const r of slice) {
                const ts      = `${isoDate(r.timestamp)} ${isoTime(r.timestamp)}`;
                const who     = showDm
                    ? `${handle(r.from)} → ${handle(r.to)}`
                    : handle(r.from);
                const preview = r.text.replace(/\s+/g, ' ').trim().slice(0, 100);
                const ellip   = r.text.length > 100 ? '…' : '';
                io.log(`  [${ts}] ${who.padEnd(showDm ? 28 : 14)}  ${preview}${ellip}`);
            }
        }

        io.log('');
        io.log(SEP);
        io.log('');
    },
};
