/**
 * Tests for ValidateToolPack — compliance validation tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { ValidateToolPack } from '../src/packs/ValidateToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-validate-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new ValidateToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

async function run(
    sandbox: Sandbox,
    agentPath: string,
    checks?: string,
): Promise<{ status: string; violations: Array<{ rule: string; path: string; hint: string }>; summary: Record<string, unknown> }> {
    const args: Record<string, unknown> = { path: agentPath };
    if (checks) args['checks'] = checks;
    const raw = await sandbox.execCall('validate/run', args, '@sentinel');
    const arrow = raw.indexOf(' \u2192 ');
    return JSON.parse(raw.slice(arrow + 3));
}

function mkdir(root: string, ...parts: string[]) {
    fs.mkdirSync(path.join(root, ...parts), { recursive: true });
}
function write(root: string, agentPath: string, content: string) {
    const real = path.join(root, agentPath);
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, content, 'utf-8');
}

// ─── INDEX_MISSING ───────────────────────────────────────────────

describe('INDEX_MISSING check', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('reports INDEX_MISSING for a directory without index.md', async () => {
        mkdir(root, 'home', 'subdir');
        const r = await run(sandbox, '/home', 'index');
        expect(r.status).toBe('fail');
        expect(r.violations.some(v => v.rule === 'INDEX_MISSING' && v.path === '/home/subdir')).toBe(true);
    });

    it('passes when all directories have index.md', async () => {
        write(root, 'home/index.md', '# Home\n');
        const r = await run(sandbox, '/home', 'index');
        expect(r.status).toBe('pass');
        expect(r.violations).toHaveLength(0);
    });

    it('checks the root path itself for index.md', async () => {
        // home/ exists but has no index.md
        const r = await run(sandbox, '/home', 'index');
        expect(r.violations.some(v => v.rule === 'INDEX_MISSING' && v.path === '/home')).toBe(true);
    });

    it('skips hidden directories', async () => {
        write(root, 'home/index.md', '# Home\n');
        mkdir(root, 'home', '.hidden');
        const r = await run(sandbox, '/home', 'index');
        expect(r.status).toBe('pass');
    });

    it('reports nested missing index.md', async () => {
        write(root, 'home/index.md', '# Home\n');
        mkdir(root, 'home', 'deep', 'nested');
        write(root, 'home/deep/index.md', '# Deep\n');
        // home/deep/nested/ has no index.md
        const r = await run(sandbox, '/home', 'index');
        expect(r.violations.some(v => v.rule === 'INDEX_MISSING' && v.path.includes('nested'))).toBe(true);
    });
});

// ─── MANIFEST_DEAD ───────────────────────────────────────────────

describe('MANIFEST_DEAD check', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('reports MANIFEST_DEAD for a broken link in index.md', async () => {
        write(root, 'home/index.md', '# Home\n- [missing](./missing.md)\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.some(v => v.rule === 'MANIFEST_DEAD')).toBe(true);
    });

    it('passes when all links in index.md resolve', async () => {
        write(root, 'home/index.md', '- [notes](./notes.md)\n');
        write(root, 'home/notes.md', '# Notes\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_DEAD')).toHaveLength(0);
    });

    it('ignores external links', async () => {
        write(root, 'home/index.md', '- [external](https://example.com)\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_DEAD')).toHaveLength(0);
    });

    it('strips fragment from link before checking', async () => {
        write(root, 'home/index.md', '- [section](./notes.md#heading)\n');
        write(root, 'home/notes.md', '# Notes\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_DEAD')).toHaveLength(0);
    });
});

// ─── MANIFEST_UNDOC ──────────────────────────────────────────────

describe('MANIFEST_UNDOC check', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('reports MANIFEST_UNDOC for a file not mentioned in index.md', async () => {
        write(root, 'home/index.md', '# Home\n');
        write(root, 'home/secret.md', '# Secret\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.some(v => v.rule === 'MANIFEST_UNDOC' && v.path.includes('secret.md'))).toBe(true);
    });

    it('passes when all files are mentioned in index.md', async () => {
        write(root, 'home/index.md', '# Home\n- `notes.md`: Notes\n');
        write(root, 'home/notes.md', '# Notes\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_UNDOC')).toHaveLength(0);
    });

    it('does not flag index.md itself as undocumented', async () => {
        write(root, 'home/index.md', '# Home\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.filter(v => v.path.includes('index.md') && v.rule === 'MANIFEST_UNDOC')).toHaveLength(0);
    });

    it('reports MANIFEST_UNDOC for an undocumented subdirectory', async () => {
        write(root, 'home/index.md', '# Home\n');
        mkdir(root, 'home', 'subdir');
        write(root, 'home/subdir/index.md', '# Sub\n');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.some(v => v.rule === 'MANIFEST_UNDOC' && v.path.includes('subdir'))).toBe(true);
    });

    it('skips hidden files', async () => {
        write(root, 'home/index.md', '# Home\n');
        write(root, 'home/.hidden', 'x');
        const r = await run(sandbox, '/home', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_UNDOC')).toHaveLength(0);
    });

    it('passes when a file matches a wildcard pattern in index.md', async () => {
        write(root, 'home/diary/index.md', '# Diary\n- `*.md`: Daily entries.\n');
        write(root, 'home/diary/2026-03-02.md', '# Day 1\n');
        write(root, 'home/diary/2026-03-03.md', '# Day 2\n');
        const r = await run(sandbox, '/home/diary', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_UNDOC')).toHaveLength(0);
    });

    it('passes when a file matches a prefix wildcard pattern', async () => {
        write(root, 'home/logs/index.md', '# Logs\n- `2026-*.md`: Log files.\n');
        write(root, 'home/logs/2026-03-01.md', 'log\n');
        const r = await run(sandbox, '/home/logs', 'manifest');
        expect(r.violations.filter(v => v.rule === 'MANIFEST_UNDOC')).toHaveLength(0);
    });

    it('still flags a file that does not match any wildcard', async () => {
        write(root, 'home/logs/index.md', '# Logs\n- `2026-*.md`: Log files.\n');
        write(root, 'home/logs/2026-03-01.md', 'log\n');
        write(root, 'home/logs/README.md', 'readme\n');
        const r = await run(sandbox, '/home/logs', 'manifest');
        expect(r.violations.some(v => v.rule === 'MANIFEST_UNDOC' && v.path.includes('README.md'))).toBe(true);
    });
});

// ─── BROKEN_REF ──────────────────────────────────────────────────

describe('BROKEN_REF check', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('reports BROKEN_REF for a broken link in a non-index .md file', async () => {
        write(root, 'home/notes.md', '# Notes\n[broken](./missing.md)\n');
        const r = await run(sandbox, '/home', 'refs');
        expect(r.violations.some(v => v.rule === 'BROKEN_REF' && v.path === '/home/notes.md')).toBe(true);
    });

    it('passes when link resolves', async () => {
        write(root, 'home/notes.md', '[ok](./other.md)\n');
        write(root, 'home/other.md', '# Other\n');
        const r = await run(sandbox, '/home', 'refs');
        expect(r.violations.filter(v => v.rule === 'BROKEN_REF')).toHaveLength(0);
    });

    it('does not run BROKEN_REF on index.md files', async () => {
        // index.md with broken link — should only be caught by MANIFEST_DEAD, not BROKEN_REF
        write(root, 'home/index.md', '[broken](./ghost.md)\n');
        const r = await run(sandbox, '/home', 'refs');
        expect(r.violations.filter(v => v.rule === 'BROKEN_REF')).toHaveLength(0);
    });

    it('ignores external links', async () => {
        write(root, 'home/notes.md', '[ext](https://example.com)\n');
        const r = await run(sandbox, '/home', 'refs');
        expect(r.violations.filter(v => v.rule === 'BROKEN_REF')).toHaveLength(0);
    });
});

// ─── CONTEXT_SCHEMA ──────────────────────────────────────────────

describe('CONTEXT_SCHEMA check', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    const COMPLIANT_CONTEXT = [
        '# Context',
        '## Active Project',
        '- None',
        '## Current Task',
        '- None',
        '## Current Protocols',
        '- None',
        '## Mini Checklist',
        '(empty)',
        '## Open Questions / Blockers',
        '- None.',
        '## Recent Updates',
        '- None.',
    ].join('\n');

    it('passes for a compliant CONTEXT.md', async () => {
        write(root, 'home/CONTEXT.md', COMPLIANT_CONTEXT);
        const r = await run(sandbox, '/home', 'context');
        expect(r.violations.filter(v => v.rule === 'CONTEXT_SCHEMA')).toHaveLength(0);
    });

    it('reports one CONTEXT_SCHEMA violation per file listing all missing sections', async () => {
        write(root, 'home/CONTEXT.md', '# Context\n\n## Active Project\n- None\n');
        const r = await run(sandbox, '/home', 'context');
        const violations = r.violations.filter(v => v.rule === 'CONTEXT_SCHEMA');
        expect(violations.length).toBeGreaterThan(0);
        // Should flag all missing sections
        const hints = violations.map(v => v.hint);
        expect(hints.some(h => h.includes('Current Task'))).toBe(true);
        expect(hints.some(h => h.includes('Mini Checklist'))).toBe(true);
    });

    it('does not check files named other than CONTEXT.md', async () => {
        write(root, 'home/notes.md', '# Notes\njust content\n');
        const r = await run(sandbox, '/home', 'context');
        expect(r.violations.filter(v => v.rule === 'CONTEXT_SCHEMA')).toHaveLength(0);
    });
});

// ─── Home directory validation ────────────────────────────────────

describe('home directory validation', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    const COMPLIANT_CONTEXT = [
        'Active Project: None',
        'Current Task: None',
        '## Mini Checklist',
        'Blockers: None',
        '## Recent Updates',
    ].join('\n');

    it('passes for a clean agent home with all required files documented', async () => {
        write(root, 'home/nova/index.md', '# Nova Home\n- `CONTEXT.md`: Active task state.\n- `AGENTS.md`: Agent profile.\n');
        write(root, 'home/nova/CONTEXT.md', COMPLIANT_CONTEXT);
        write(root, 'home/nova/AGENTS.md', '# Agent Profile: @nova\n');
        const r = await run(sandbox, '/home/nova');
        expect(r.status).toBe('pass');
    });

    it('catches CONTEXT_SCHEMA in agent home CONTEXT.md', async () => {
        write(root, 'home/nova/index.md', '# Nova Home\n- `CONTEXT.md`: Active task state.\n');
        write(root, 'home/nova/CONTEXT.md', '## Active Project\nNone\n');
        const r = await run(sandbox, '/home/nova', 'context');
        expect(r.violations.some(v => v.rule === 'CONTEXT_SCHEMA' && v.path === '/home/nova/CONTEXT.md')).toBe(true);
    });

    it('catches INDEX_MISSING in an agent home subdir', async () => {
        write(root, 'home/nova/index.md', '# Nova Home\n- `research/`: Research notes.\n');
        mkdir(root, 'home', 'nova', 'research');
        // research/ exists but has no index.md
        const r = await run(sandbox, '/home/nova', 'index');
        expect(r.violations.some(v => v.rule === 'INDEX_MISSING' && v.path.includes('research'))).toBe(true);
    });

    it('catches MANIFEST_UNDOC for an unindexed file in agent home', async () => {
        write(root, 'home/ivy/index.md', '# Ivy Home\n');
        write(root, 'home/ivy/CONTEXT.md', COMPLIANT_CONTEXT);
        // CONTEXT.md exists but is not mentioned in index.md
        const r = await run(sandbox, '/home/ivy', 'manifest');
        expect(r.violations.some(v => v.rule === 'MANIFEST_UNDOC' && v.path.includes('CONTEXT.md'))).toBe(true);
    });
});

// ─── Summary and status ───────────────────────────────────────────

describe('summary and status', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns status pass with 0 violations on a clean workspace', async () => {
        write(root, 'home/index.md', '# Home\n- `notes.md`: Notes.\n');
        write(root, 'home/notes.md', '# Notes\n');
        const r = await run(sandbox, '/home');
        expect(r.status).toBe('pass');
        expect(r.summary['violations']).toBe(0);
        expect(r.summary['directories_checked']).toBeGreaterThanOrEqual(1);
        expect(r.summary['files_checked']).toBeGreaterThanOrEqual(1);
    });

    it('returns status fail with correct violation count', async () => {
        mkdir(root, 'home', 'noindex');
        const r = await run(sandbox, '/home');
        expect(r.status).toBe('fail');
        expect((r.summary['violations'] as number)).toBeGreaterThan(0);
        expect(r.violations.length).toBe(r.summary['violations']);
    });

    it('checks subset when checks param is specified', async () => {
        // Create a dir without index.md and a broken ref — only run index check
        mkdir(root, 'home', 'noindex');
        write(root, 'home/notes.md', '[broken](./ghost.md)\n');
        const r = await run(sandbox, '/home', 'index');
        const rules = r.violations.map(v => v.rule);
        expect(rules.every(rule => rule === 'INDEX_MISSING')).toBe(true);
    });

    it('throws for a non-existent path', async () => {
        await expect(run(sandbox, '/home/nonexistent')).rejects.toThrow();
    });

    it('throws for a file path (not a directory)', async () => {
        write(root, 'home/file.md', '# File\n');
        await expect(run(sandbox, '/home/file.md')).rejects.toThrow(/directory/i);
    });
});

// ─── validate: skip ──────────────────────────────────────────────

describe('validate: skip marker', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('suppresses INDEX_MISSING for children of a skipped directory', async () => {
        write(root, 'home/index.md', '- `private/`: Private.\n');
        write(root, 'home/private/index.md', 'validate: skip\n\n- `*`: All contents.\n');
        // subdir inside private/ has no index.md — would normally be INDEX_MISSING
        fs.mkdirSync(path.join(root, 'home', 'private', 'subdir'), { recursive: true });

        const r = await run(sandbox, '/home');
        expect(r.violations.filter(v => v.path.includes('subdir'))).toHaveLength(0);
    });

    it('suppresses MANIFEST_UNDOC for contents of a skipped directory', async () => {
        write(root, 'home/index.md', '- `private/`: Private.\n');
        write(root, 'home/private/index.md', 'validate: skip\n\n- `*`: All contents.\n');
        write(root, 'home/private/undocumented.md', '# Undocumented\n');

        const r = await run(sandbox, '/home');
        expect(r.violations.filter(v => v.path.includes('undocumented'))).toHaveLength(0);
    });

    it('suppresses BROKEN_REF inside a skipped directory', async () => {
        write(root, 'home/index.md', '- `private/`: Private.\n');
        write(root, 'home/private/index.md', 'validate: skip\n\n- `*`: All contents.\n');
        write(root, 'home/private/notes.md', '[broken](./ghost.md)\n');

        const r = await run(sandbox, '/home');
        expect(r.violations.filter(v => v.rule === 'BROKEN_REF')).toHaveLength(0);
    });

    it('still checks the skipped directory itself (INDEX_MISSING on the dir)', async () => {
        write(root, 'home/index.md', '- `private/`: Private.\n');
        // private/ exists but has no index.md at all
        fs.mkdirSync(path.join(root, 'home', 'private'), { recursive: true });

        const r = await run(sandbox, '/home', 'index');
        expect(r.violations.some(v => v.rule === 'INDEX_MISSING' && v.path.includes('private'))).toBe(true);
    });
});

// ─── CONTEXT_STALE ────────────────────────────────────────────────

describe('CONTEXT_STALE check', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    function ctx(activeProject: string, items: string[]) {
        const checklist = items.length === 0
            ? '(empty)'
            : items.map(s => `  - ${s}`).join('\n');
        return [
            `Active Project: ${activeProject}`,
            'Current Task: build something',
            'Current Protocols: WORKFLOW.md',
            'Mini Checklist:',
            checklist,
            'Open Questions: None',
            'Recent Updates: None',
        ].join('\n');
    }

    it('fires when Active Project is set and all items are [x]', async () => {
        write(root, 'home/nova/CONTEXT.md', ctx('MyProject', ['[x] write spec', '[x] review']));
        const r = await run(sandbox, '/home/nova', 'context');
        expect(r.violations.some(v => v.rule === 'CONTEXT_STALE')).toBe(true);
    });

    it('does not fire when at least one item is [ ]', async () => {
        write(root, 'home/nova/CONTEXT.md', ctx('MyProject', ['[x] write spec', '[ ] review']));
        const r = await run(sandbox, '/home/nova', 'context');
        expect(r.violations.filter(v => v.rule === 'CONTEXT_STALE')).toHaveLength(0);
    });

    it('does not fire when at least one item is [/] (in progress)', async () => {
        write(root, 'home/nova/CONTEXT.md', ctx('MyProject', ['[x] write spec', '[/] review']));
        const r = await run(sandbox, '/home/nova', 'context');
        expect(r.violations.filter(v => v.rule === 'CONTEXT_STALE')).toHaveLength(0);
    });

    it('does not fire when Active Project is None', async () => {
        write(root, 'home/nova/CONTEXT.md', ctx('None', ['[x] write spec']));
        const r = await run(sandbox, '/home/nova', 'context');
        expect(r.violations.filter(v => v.rule === 'CONTEXT_STALE')).toHaveLength(0);
    });

    it('does not fire when checklist is empty', async () => {
        write(root, 'home/nova/CONTEXT.md', ctx('MyProject', []));
        const r = await run(sandbox, '/home/nova', 'context');
        expect(r.violations.filter(v => v.rule === 'CONTEXT_STALE')).toHaveLength(0);
    });

    it('hint mentions clearing the checklist and resetting Active Project', async () => {
        write(root, 'home/nova/CONTEXT.md', ctx('MyProject', ['[x] done']));
        const r = await run(sandbox, '/home/nova', 'context');
        const v = r.violations.find(v => v.rule === 'CONTEXT_STALE');
        expect(v?.hint).toContain('Active Project');
        expect(v?.hint).toContain('[x]');
    });
});
