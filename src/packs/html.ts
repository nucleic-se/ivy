/**
 * HTML → Markdown extraction via Defuddle.
 *
 * Defuddle strips boilerplate (nav, ads, footers) and returns clean article
 * Markdown. Used by FetchToolPack and TextToolPack's to_markdown tool.
 */

import { Defuddle } from 'defuddle/node';

/** Minimum usable output length — shorter results are treated as extraction failure. */
const MIN_OUTPUT_CHARS = 50;

/**
 * Extract clean Markdown from an HTML string.
 *
 * The `url` parameter is passed to Defuddle as a base for resolving relative
 * links. Pass an empty string or the sandbox path when the origin URL is unknown.
 *
 * Defuddle emits noise to console.error during DOM parsing. We capture those
 * lines and re-emit only the ones that don't look like internal parser chatter
 * (anything that doesn't mention "parse" or "DOM").
 *
 * Returns null when extraction fails or produces too little content.
 */
export async function extractMarkdown(html: string, url: string): Promise<string | null> {
    const origError = console.error;
    const suppressed: unknown[][] = [];
    console.error = (...args: unknown[]) => { suppressed.push(args); };
    try {
        const result = await Defuddle(html, url, { markdown: true });
        const text = result.content;
        if (!text || text.length < MIN_OUTPUT_CHARS) return null;
        return text;
    } catch {
        return null;
    } finally {
        console.error = origError;
        for (const args of suppressed) {
            const msg = String(args[0] ?? '');
            if (msg && !msg.includes('parse') && !msg.includes('DOM')) {
                origError.apply(console, args as [unknown, ...unknown[]]);
            }
        }
    }
}
