/**
 * Tests for FetchToolPack (fetch/get) and TextToolPack's text/to_markdown tool.
 *
 * IFetcher is replaced with a simple stub — no real HTTP calls.
 * Defuddle is exercised against actual HTML strings so the extraction
 * path is real code, not mocked.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Stub extractMarkdown — these are unit tests for tool behavior (file I/O, path routing,
// content-type branching). Defuddle DOM parsing is an integration concern tested separately.
vi.mock('../src/packs/html.js', () => ({
    extractMarkdown: vi.fn(async (html: string) => {
        // Strip tags and return if there's enough text; mirrors what the real function does.
        const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return stripped.length >= 50 ? `# Extracted\n\n${stripped}` : null;
    }),
}));
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { IFetcher, FetchResponse } from 'gears';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { FetchToolPack } from '../src/packs/FetchToolPack.js';
import { TextToolPack } from '../src/packs/TextToolPack.js';

// ─── Helpers ────────────────────────────────────────────────────

class TestableSandbox extends Sandbox {
    constructor(explicitRoot: string) {
        super();
        (this as any).root = explicitRoot;
        for (const dir of ['home', 'tools', 'data', 'tmp']) {
            fs.mkdirSync(path.join(explicitRoot, dir), { recursive: true });
        }
    }
}

function tempSandbox() {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-fetch-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

/** Minimal IFetcher stub that returns a preset response. */
function makeFetcher(overrides: Partial<FetchResponse> = {}): IFetcher {
    const defaults: FetchResponse = {
        body: `<!DOCTYPE html><html><head><title>Hello</title></head><body>
<article><h1>Hello</h1>
<p>This is the first paragraph with sufficient content for Defuddle extraction to work correctly.</p>
<p>A second paragraph adds more body so the library has enough signal to produce clean Markdown output.</p>
<p>And a third paragraph to push well past the minimum length threshold for extracted content.</p>
</article></body></html>`,
        status: 200,
        headers: {},
        contentType: 'text/html; charset=utf-8',
    };
    const response = { ...defaults, ...overrides };
    return {
        get: async () => response,
        post: async () => response,
    };
}

/** Call a tool through sandbox.execCall and parse the JSON result. */
async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>): Promise<any> {
    const raw = await sandbox.execCall(tool, args, '@test');
    const arrow = raw.indexOf(' → ');
    if (arrow === -1) throw new Error(`No arrow in result: ${raw}`);
    return JSON.parse(raw.slice(arrow + 3));
}

// ─── fetch/get ───────────────────────────────────────────────────

describe('fetch/get', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
    });
    afterEach(() => cleanup());

    function mount(fetcher: IFetcher) {
        sandbox.mount(new FetchToolPack(fetcher, sandbox).createLayer());
    }

    it('saves HTML as Markdown to default /tmp/<md5>.md path', async () => {
        mount(makeFetcher());
        const url = 'https://example.com/article';
        const r = await call(sandbox, 'fetch/get', { url });

        const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
        expect(r.path).toBe(`/tmp/${hash}.md`);
        expect(r.status).toBe(200);
        expect(r.converted).toBe(true);
        expect(r.bytes).toBeGreaterThan(0);

        const realPath = path.join(root, 'tmp', `${hash}.md`);
        expect(fs.existsSync(realPath)).toBe(true);
        const content = fs.readFileSync(realPath, 'utf-8');
        expect(content).toContain('Hello');
    });

    it('saves to a specified path', async () => {
        mount(makeFetcher());
        const r = await call(sandbox, 'fetch/get', { url: 'https://example.com/', path: '/home/page.md' });
        expect(r.path).toBe('/home/page.md');
        expect(fs.existsSync(path.join(root, 'home', 'page.md'))).toBe(true);
    });

    it('skips Markdown conversion when raw=true', async () => {
        const html = '<html><body><p>raw content</p></body></html>';
        mount(makeFetcher({ body: html, contentType: 'text/html' }));
        const r = await call(sandbox, 'fetch/get', { url: 'https://example.com/', raw: true });
        expect(r.converted).toBe(false);
        const realPath = path.join(root, 'tmp', r.path.replace('/tmp/', ''));
        expect(fs.readFileSync(realPath, 'utf-8')).toBe(html);
    });

    it('saves non-HTML response without conversion', async () => {
        mount(makeFetcher({ body: '{"key":"value"}', contentType: 'application/json', status: 200 }));
        const r = await call(sandbox, 'fetch/get', { url: 'https://api.example.com/data', path: '/tmp/data.json' });
        expect(r.converted).toBe(false);
        expect(r.path).toBe('/tmp/data.json');
        const saved = fs.readFileSync(path.join(root, 'tmp', 'data.json'), 'utf-8');
        expect(saved).toContain('"key"');
    });

    it('same URL always maps to the same default path', async () => {
        mount(makeFetcher());
        const url = 'https://example.com/stable';
        const r1 = await call(sandbox, 'fetch/get', { url });
        const r2 = await call(sandbox, 'fetch/get', { url });
        expect(r1.path).toBe(r2.path);
    });

    it('rejects non-http/https URLs', async () => {
        mount(makeFetcher());
        await expect(call(sandbox, 'fetch/get', { url: 'ftp://example.com' })).rejects.toThrow(/http/);
    });

    it('rejects writes to /tools (read-only)', async () => {
        mount(makeFetcher());
        await expect(call(sandbox, 'fetch/get', { url: 'https://example.com/', path: '/tools/bad.md' }))
            .rejects.toThrow(/read-only/);
    });

    it('tool is discoverable via ls /tools/fetch', async () => {
        mount(makeFetcher());
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/fetch' });
        expect(result).toContain('f  get.json');
    });

    it('tool manifest is readable', async () => {
        mount(makeFetcher());
        const result = await sandbox.execFs({ type: 'fs', op: 'read', path: '/tools/fetch/get.json' });
        const json = JSON.parse(result.split('\n').slice(1).join('\n'));
        expect(json.name).toBe('get');
        expect(json.group).toBe('fetch');
    });
});

// ─── fetch/post ──────────────────────────────────────────────────

describe('fetch/post', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
    });
    afterEach(() => cleanup());

    function mount(fetcher: IFetcher) {
        sandbox.mount(new FetchToolPack(fetcher, sandbox).createLayer());
    }

    it('returns inline body when no save_path', async () => {
        mount(makeFetcher({ body: '{"ok":true}', contentType: 'application/json', status: 200 }));
        const r = await call(sandbox, 'fetch/post', { url: 'https://api.example.com/hook', body: '{}' });
        expect(r.status).toBe(200);
        expect(r.content_type).toBe('application/json');
        expect(r.body).toBe('{"ok":true}');
        expect(r.truncated).toBe(false);
        expect(r.path).toBeUndefined();
    });

    it('saves response to sandbox when save_path given', async () => {
        mount(makeFetcher({ body: '{"result":"done"}', contentType: 'application/json', status: 201 }));
        const r = await call(sandbox, 'fetch/post', {
            url: 'https://api.example.com/create',
            body: '{"name":"test"}',
            save_path: '/tmp/response.json',
        });
        expect(r.status).toBe(201);
        expect(r.path).toBe('/tmp/response.json');
        expect(r.bytes).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(root, 'tmp', 'response.json'))).toBe(true);
        expect(r.body).toBeUndefined();
    });

    it('uses application/json content-type by default', async () => {
        let capturedOptions: any;
        const fetcher: IFetcher = {
            get: async () => { throw new Error('not used'); },
            post: async (_url, _body, options) => {
                capturedOptions = options;
                return { body: 'ok', status: 200, headers: {}, contentType: 'text/plain' };
            },
        };
        mount(fetcher);
        await call(sandbox, 'fetch/post', { url: 'https://example.com/', body: '{}' });
        expect(capturedOptions.headers['Content-Type']).toBe('application/json');
    });

    it('forwards custom content_type and headers', async () => {
        let capturedOptions: any;
        const fetcher: IFetcher = {
            get: async () => { throw new Error('not used'); },
            post: async (_url, _body, options) => {
                capturedOptions = options;
                return { body: 'ok', status: 200, headers: {}, contentType: 'text/plain' };
            },
        };
        mount(fetcher);
        await call(sandbox, 'fetch/post', {
            url: 'https://example.com/',
            body: 'data',
            content_type: 'text/plain',
            headers: { 'X-Token': 'abc' },
        });
        expect(capturedOptions.headers['Content-Type']).toBe('text/plain');
        expect(capturedOptions.headers['X-Token']).toBe('abc');
    });

    it('converts HTML response to Markdown when save_path given', async () => {
        mount(makeFetcher()); // default fetcher returns HTML
        const r = await call(sandbox, 'fetch/post', {
            url: 'https://example.com/',
            body: '{}',
            save_path: '/tmp/result.md',
        });
        expect(r.converted).toBe(true);
        const content = fs.readFileSync(path.join(root, 'tmp', 'result.md'), 'utf-8');
        expect(content).toContain('Hello');
    });

    it('skips HTML conversion when save_path + raw=true', async () => {
        const html = '<html><body><p>raw</p></body></html>';
        mount(makeFetcher({ body: html, contentType: 'text/html' }));
        const r = await call(sandbox, 'fetch/post', {
            url: 'https://example.com/',
            body: '{}',
            save_path: '/tmp/raw.html',
            raw: true,
        });
        expect(r.converted).toBe(false);
        expect(fs.readFileSync(path.join(root, 'tmp', 'raw.html'), 'utf-8')).toBe(html);
    });

    it('truncates large inline responses', async () => {
        const bigBody = 'x'.repeat(8 * 1024); // 8 KB > 4 KB inline cap
        mount(makeFetcher({ body: bigBody, contentType: 'application/json', status: 200 }));
        const r = await call(sandbox, 'fetch/post', { url: 'https://example.com/', body: '{}' });
        expect(r.truncated).toBe(true);
        expect(r.body.length).toBe(4 * 1024);
    });

    it('rejects non-http/https URLs', async () => {
        mount(makeFetcher());
        await expect(call(sandbox, 'fetch/post', { url: 'ftp://example.com', body: '{}' }))
            .rejects.toThrow(/http/);
    });

    it('rejects save_path in read-only zone', async () => {
        mount(makeFetcher());
        await expect(call(sandbox, 'fetch/post', {
            url: 'https://example.com/',
            body: '{}',
            save_path: '/tools/bad.json',
        })).rejects.toThrow(/read-only/);
    });

    it('tool is discoverable via ls /tools/fetch', async () => {
        mount(makeFetcher());
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/fetch' });
        expect(result).toContain('f  post.json');
    });
});

// ─── text/to_markdown ────────────────────────────────────────────

describe('text/to_markdown', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        sandbox.mount(new TextToolPack(sandbox).createLayer());
    });
    afterEach(() => cleanup());

    // Needs to be substantial enough for Defuddle to identify readable content.
    const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Article</title></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main>
<article>
<h1>Main Title</h1>
<p>This is the first paragraph of the article with enough content for Defuddle to identify it as readable prose.</p>
<p>Here is a second paragraph that adds more substance to the article body so the extractor has sufficient signal to work with.</p>
<p>And a third paragraph to make absolutely sure the content passes the minimum length threshold required by the extraction library.</p>
</article>
</main>
<footer><p>Site footer with copyright notice and links.</p></footer>
</body></html>`;

    it('converts HTML file to Markdown in place', async () => {
        fs.writeFileSync(path.join(root, 'home', 'page.html'), SAMPLE_HTML, 'utf-8');
        const r = await call(sandbox, 'text/to_markdown', { path: '/home/page.html' });
        expect(r.path).toBe('/home/page.html');
        expect(r.bytes).toBeGreaterThan(0);
        const content = fs.readFileSync(path.join(root, 'home', 'page.html'), 'utf-8');
        expect(content).toContain('Main Title');
        expect(content).not.toContain('<html>');
    });

    it('writes to dest when specified', async () => {
        fs.writeFileSync(path.join(root, 'home', 'raw.html'), SAMPLE_HTML, 'utf-8');
        const r = await call(sandbox, 'text/to_markdown', { path: '/home/raw.html', dest: '/home/clean.md' });
        expect(r.path).toBe('/home/clean.md');
        expect(fs.existsSync(path.join(root, 'home', 'clean.md'))).toBe(true);
        // source should be untouched
        expect(fs.readFileSync(path.join(root, 'home', 'raw.html'), 'utf-8')).toContain('<article>');
    });

    it('passes url hint for link resolution', async () => {
        fs.writeFileSync(path.join(root, 'home', 'page.html'), SAMPLE_HTML, 'utf-8');
        // Should not throw with a url hint provided
        const r = await call(sandbox, 'text/to_markdown', { path: '/home/page.html', url: 'https://example.com/page' });
        expect(r.bytes).toBeGreaterThan(0);
    });

    it('throws when path does not exist', async () => {
        await expect(call(sandbox, 'text/to_markdown', { path: '/home/missing.html' })).rejects.toThrow(/No such file/);
    });

    it('throws when dest is in read-only zone', async () => {
        fs.writeFileSync(path.join(root, 'home', 'page.html'), SAMPLE_HTML, 'utf-8');
        await expect(
            call(sandbox, 'text/to_markdown', { path: '/home/page.html', dest: '/tools/bad.md' }),
        ).rejects.toThrow(/read-only/);
    });

    it('tool appears in text group listing', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/text' });
        expect(result).toContain('f  to_markdown.json');
    });
});
