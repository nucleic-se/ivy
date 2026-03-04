/**
 * Shared argument helpers used across multiple tool packs.
 */

import * as path from 'node:path';

export function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v === 'string') return v;
    // LLMs occasionally emit string arrays; join them rather than hard-rejecting.
    if (Array.isArray(v) && v.length > 0 && v.every(item => typeof item === 'string')) {
        return (v as string[]).join('\n');
    }
    if (!(key in args) || v === undefined) throw new Error(`missing required argument: "${key}"`);
    if (v === null) throw new Error(`"${key}" must be a string, got null`);
    throw new Error(`"${key}" must be a string, got ${typeof v}`);
}

export function normAgentPath(raw: string): string {
    const p = path.normalize(raw);
    if (!path.isAbsolute(p)) throw new Error(`Path must be absolute, got: ${raw}`);
    return p;
}

/**
 * Convert a glob pattern (containing *) to a RegExp.
 * Only * is supported — matches any sequence of characters except /.
 */
export function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
}

/**
 * Return true if the entry name is documented in the index.md content.
 * Accepts:
 *   - backtick exact:  `name` or `name/`
 *   - link exact:      [name] or [name/]
 *   - backtick glob:   `*.md` — any backtick-quoted token containing * that glob-matches
 */
export function isDocumentedInIndex(name: string, _isDir: boolean, content: string): boolean {
    const withSlash = `${name}/`;
    if (content.includes(`\`${name}\``) || content.includes(`\`${withSlash}\``)) return true;
    if (content.includes(`[${name}]`) || content.includes(`[${withSlash}]`)) return true;
    const tokenRe = /`([^`]*\*[^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(content)) !== null) {
        const pattern = m[1]!;
        const patternBase = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
        if (globToRegex(patternBase).test(name)) return true;
    }
    return false;
}
