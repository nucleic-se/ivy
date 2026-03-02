/**
 * FetchToolPack — HTTP fetch tool group for sandbox agents.
 *
 * Mounts at /tools/fetch/ via ToolGroupPack.
 *
 * Tools:
 *   fetch/get  — Fetch a URL and save the response to the sandbox.
 *                HTML responses are converted to clean Markdown via Defuddle
 *                unless `raw` is set. The default save path is
 *                /tmp/<md5(url).slice(0,12)>.md so repeated fetches of the
 *                same URL always land in the same file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IFetcher } from 'gears';
import type { Sandbox } from '../sandbox/Sandbox.js';
import type { SandboxLayer } from '../sandbox/layer.js';
import { ToolGroupPack } from '../sandbox/ToolGroupPack.js';
import type { Tool } from '../sandbox/ToolGroupPack.js';
import { extractMarkdown } from './html.js';

const TIMEOUT_MS = 15_000;
const RETRIES    = 1;
const MAX_BYTES  = 4 * 1024 * 1024; // 4 MB response cap

export class FetchToolPack {
    constructor(
        private fetcher: IFetcher,
        private sandbox: Sandbox,
    ) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('fetch', [
            this.getTool(),
        ]).createLayer();
    }

    // ── fetch/get ───────────────────────────────────────────────

    private getTool(): Tool {
        const { fetcher, sandbox } = this;
        return {
            name: 'get',
            description: [
                'Fetch a URL and save the response to the sandbox.',
                'HTML is converted to clean Markdown unless raw=true.',
                'Default path: /tmp/<md5>.md — same URL always maps to the same file.',
            ].join(' '),
            parameters: {
                url:  { type: 'string',  description: 'Full URL to fetch (http/https)', required: true },
                path: { type: 'string',  description: 'Sandbox destination path. Defaults to /tmp/<md5(url)>.md', required: false },
                raw:  { type: 'boolean', description: 'Save raw response body without HTML→Markdown conversion (default: false)', required: false },
            },
            returns: '{ path, status, bytes, converted }',
            handler: async (args, callerHandle) => {
                const url = requireString(args, 'url');
                if (!/^https?:\/\//i.test(url)) {
                    throw new Error(`URL must start with http:// or https://, got: ${url}`);
                }

                const raw = args['raw'] === true;
                const agentPath = typeof args['path'] === 'string'
                    ? normAgentPath(args['path'])
                    : defaultPath(url);

                sandbox.assertWritable(agentPath, callerHandle);
                const realDest = sandbox.resolveForWrite(agentPath);

                const response = await fetcher.get(url, { timeout: TIMEOUT_MS, retries: RETRIES });

                const body = response.body;
                const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');

                if (Buffer.byteLength(bodyStr, 'utf-8') > MAX_BYTES) {
                    throw new Error(`Response too large (limit ${MAX_BYTES / 1024} KB)`);
                }

                const isHtml = response.contentType.includes('text/html');
                let content: string;
                let converted = false;

                if (isHtml && !raw) {
                    const md = await extractMarkdown(bodyStr, url);
                    content = md ?? bodyStr; // fall back to raw if Defuddle returns nothing
                    converted = md !== null;
                } else {
                    content = bodyStr;
                }

                fs.mkdirSync(path.dirname(realDest), { recursive: true });
                fs.writeFileSync(realDest, content, 'utf-8');

                return {
                    path: agentPath,
                    status: response.status,
                    bytes: Buffer.byteLength(content, 'utf-8'),
                    converted,
                };
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

function normAgentPath(p: string): string {
    const normalized = path.normalize(p);
    if (!path.isAbsolute(normalized)) throw new Error(`Path must be absolute, got: ${p}`);
    return normalized;
}

/** /tmp/<first 12 chars of md5(url)>.md */
function defaultPath(url: string): string {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
    return `/tmp/${hash}.md`;
}
