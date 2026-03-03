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
 *   fetch/post — Send an HTTP POST request. Optional save_path saves the
 *                response to the sandbox (with HTML→Markdown conversion).
 *                Without save_path, returns the first 4 KB of response inline.
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

const TIMEOUT_MS  = 15_000;
const RETRIES     = 1;
const MAX_BYTES   = 4 * 1024 * 1024; // 4 MB response cap
const INLINE_MAX  = 4 * 1024;        // 4 KB inline body cap for fetch/post

export class FetchToolPack {
    constructor(
        private fetcher: IFetcher,
        private sandbox: Sandbox,
    ) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('fetch', [
            this.getTool(),
            this.postTool(),
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

    // ── fetch/post ──────────────────────────────────────────────

    private postTool(): Tool {
        const { fetcher, sandbox } = this;
        return {
            name: 'post',
            description: [
                'Send an HTTP POST request.',
                'Without save_path, returns the first 4 KB of response body inline.',
                'With save_path, saves response to the sandbox (HTML→Markdown unless raw=true).',
            ].join(' '),
            parameters: {
                url:          { type: 'string',  description: 'Full URL to POST to (http/https)', required: true },
                body:         { type: 'string',  description: 'Request body string', required: true },
                content_type: { type: 'string',  description: 'Content-Type of request body (default: application/json)', required: false },
                headers:      { type: 'object',  description: 'Additional request headers', required: false },
                save_path:    { type: 'string',  description: 'Sandbox path to save response body. If omitted, first 4 KB returned inline.', required: false },
                raw:          { type: 'boolean', description: 'Skip HTML→Markdown conversion when saving (default: false)', required: false },
            },
            returns: '{ status, content_type, path, bytes, converted } when saved | { status, content_type, body, truncated } inline',
            handler: async (args, callerHandle) => {
                const url = requireString(args, 'url');
                if (!/^https?:\/\//i.test(url)) {
                    throw new Error(`URL must start with http:// or https://, got: ${url}`);
                }

                const requestBody = requireString(args, 'body');
                const contentType = typeof args['content_type'] === 'string'
                    ? args['content_type']
                    : 'application/json';
                const raw = args['raw'] === true;

                const extraHeaders: Record<string, string> = {};
                if (args['headers'] !== null && typeof args['headers'] === 'object' && !Array.isArray(args['headers'])) {
                    for (const [k, v] of Object.entries(args['headers'] as Record<string, unknown>)) {
                        if (typeof v === 'string') extraHeaders[k] = v;
                    }
                }

                const response = await fetcher.post(url, requestBody, {
                    timeout: TIMEOUT_MS,
                    retries: RETRIES,
                    headers: { 'Content-Type': contentType, ...extraHeaders },
                });

                const bodyStr = typeof response.body === 'string'
                    ? response.body
                    : response.body.toString('utf-8');

                if (Buffer.byteLength(bodyStr, 'utf-8') > MAX_BYTES) {
                    throw new Error(`Response too large (limit ${MAX_BYTES / 1024} KB)`);
                }

                // ── With save_path: mirrors fetch/get behavior ───────────
                if (typeof args['save_path'] === 'string') {
                    const agentPath = normAgentPath(args['save_path']);
                    sandbox.assertWritable(agentPath, callerHandle);
                    const realDest = sandbox.resolveForWrite(agentPath);

                    const isHtml = response.contentType.includes('text/html');
                    let content: string;
                    let converted = false;

                    if (isHtml && !raw) {
                        const md = await extractMarkdown(bodyStr, url);
                        content = md ?? bodyStr;
                        converted = md !== null;
                    } else {
                        content = bodyStr;
                    }

                    fs.mkdirSync(path.dirname(realDest), { recursive: true });
                    fs.writeFileSync(realDest, content, 'utf-8');

                    return {
                        status: response.status,
                        content_type: response.contentType,
                        path: agentPath,
                        bytes: Buffer.byteLength(content, 'utf-8'),
                        converted,
                    };
                }

                // ── Without save_path: return inline (capped) ────────────
                const truncated = Buffer.byteLength(bodyStr, 'utf-8') > INLINE_MAX;
                return {
                    status: response.status,
                    content_type: response.contentType,
                    body: bodyStr.slice(0, INLINE_MAX),
                    truncated,
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
