/**
 * Tests for ContextToolPack — context/compact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { ContextToolPack } from '../src/packs/ContextToolPack.js';

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
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-context-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    sandbox.mount(new ContextToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

function write(root: string, agentPath: string, content: string) {
    const real = path.join(root, agentPath);
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, content, 'utf-8');
}

function read(root: string, agentPath: string): string {
    return fs.readFileSync(path.join(root, agentPath), 'utf-8');
}

async function compact(sandbox: Sandbox, agentPath: string, max?: number, caller = '@nova') {
    const args: Record<string, unknown> = { path: agentPath };
    if (max !== undefined) args['max'] = max;
    const raw = await sandbox.execCall('context/compact', args, caller);
    const arrow = raw.indexOf(' → ');
    return JSON.parse(raw.slice(arrow + 3)) as {
        compacted: boolean;
        pruned_count: number;
        section_sizes: Record<string, number>;
    };
}

// Sample CONTEXT.md with a "## Recent Updates" section.
function makeContextH2(updates: string[]): string {
    const bullets = updates.map(u => `- ${u}`).join('\n');
    return `# CONTEXT

Active Project: My Project
Current Task: Task A

## Mini Checklist
- [ ] Step 1
- [ ] Step 2

## Recent Updates
${bullets}

## Notes
- Some note
`;
}

// Sample CONTEXT.md with a "Recent Updates:" colon-style heading.
function makeContextColon(updates: string[]): string {
    const bullets = updates.map(u => `- ${u}`).join('\n');
    return `Active Project: My Project

Recent Updates:
${bullets}

Notes:
- Some note
`;
}

// ─── context/compact — ## heading ─────────────────────────────────

describe('context/compact — ## Recent Updates heading', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('is a no-op when entries <= max', async () => {
        const content = makeContextH2(['Entry 1', 'Entry 2', 'Entry 3']);
        write(root, 'home/nova/CONTEXT.md', content);
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 5);
        expect(r.compacted).toBe(false);
        expect(r.pruned_count).toBe(0);
        expect(read(root, 'home/nova/CONTEXT.md')).toBe(content);
    });

    it('is a no-op when entries exactly equal max', async () => {
        const content = makeContextH2(['E1', 'E2', 'E3', 'E4', 'E5']);
        write(root, 'home/nova/CONTEXT.md', content);
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 5);
        expect(r.compacted).toBe(false);
        expect(r.pruned_count).toBe(0);
    });

    it('prunes oldest entries when count exceeds max', async () => {
        const content = makeContextH2(['Newest', 'Middle', 'Oldest']);
        write(root, 'home/nova/CONTEXT.md', content);
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 2);
        expect(r.compacted).toBe(true);
        expect(r.pruned_count).toBe(1);
        const after = read(root, 'home/nova/CONTEXT.md');
        expect(after).toContain('Newest');
        expect(after).toContain('Middle');
        expect(after).not.toContain('Oldest');
    });

    it('persists trimmed file to disk', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B', 'C', 'D', 'E', 'F']));
        await compact(sandbox, '/home/nova/CONTEXT.md', 3);
        const after = read(root, 'home/nova/CONTEXT.md');
        const bulletCount = (after.match(/^- /gm) ?? []).length;
        // 3 recent updates + 2 checklist items (from makeContextH2) + 1 note = 6, but
        // makeContextH2 has no checklist in colon format; in H2 format: 2 checklist + 3 kept + 1 note = 6
        expect(after).toContain('- A');
        expect(after).toContain('- B');
        expect(after).toContain('- C');
        expect(after).not.toContain('- D');
    });

    it('returns correct pruned_count', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['1', '2', '3', '4', '5', '6', '7']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 4);
        expect(r.pruned_count).toBe(3);
    });

    it('respects custom max = 1', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B', 'C']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 1);
        expect(r.pruned_count).toBe(2);
        const after = read(root, 'home/nova/CONTEXT.md');
        expect(after).toContain('- A');
        expect(after).not.toContain('- B');
    });

    it('returns section_sizes with Recent Updates count after compaction', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B', 'C', 'D', 'E', 'F']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 3);
        expect(r.section_sizes['Recent Updates']).toBe(3);
    });

    it('section_sizes when no compaction needed', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 5);
        expect(r.section_sizes['Recent Updates']).toBe(2);
    });

    it('preserves content outside Recent Updates section', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B', 'C', 'D', 'E', 'F']));
        await compact(sandbox, '/home/nova/CONTEXT.md', 3);
        const after = read(root, 'home/nova/CONTEXT.md');
        expect(after).toContain('Active Project: My Project');
        expect(after).toContain('## Mini Checklist');
        expect(after).toContain('## Notes');
        expect(after).toContain('Some note');
    });

    it('uses default max=5 when not provided', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['1', '2', '3', '4', '5', '6', '7']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md');
        expect(r.pruned_count).toBe(2);
        expect(r.compacted).toBe(true);
    });
});

// ─── context/compact — colon heading ─────────────────────────────

describe('context/compact — Recent Updates: colon heading', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('prunes from colon-style section', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextColon(['Newest', 'Middle', 'Oldest']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 2);
        expect(r.compacted).toBe(true);
        expect(r.pruned_count).toBe(1);
        const after = read(root, 'home/nova/CONTEXT.md');
        expect(after).toContain('Newest');
        expect(after).toContain('Middle');
        expect(after).not.toContain('Oldest');
    });

    it('is a no-op for colon style when entries <= max', async () => {
        const content = makeContextColon(['Only one']);
        write(root, 'home/nova/CONTEXT.md', content);
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 5);
        expect(r.compacted).toBe(false);
    });
});

// ─── context/compact — edge cases ────────────────────────────────

describe('context/compact — edge cases', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('is a no-op when file has no Recent Updates section', async () => {
        const content = '# CONTEXT\n\nActive Project: None\n';
        write(root, 'home/nova/CONTEXT.md', content);
        const r = await compact(sandbox, '/home/nova/CONTEXT.md');
        expect(r.compacted).toBe(false);
        expect(r.pruned_count).toBe(0);
        expect(read(root, 'home/nova/CONTEXT.md')).toBe(content);
    });

    it('throws when file does not exist', async () => {
        await expect(compact(sandbox, '/home/nova/NONEXISTENT.md'))
            .rejects.toThrow();
    });

    it('max is floored to integer (1.9 → 1)', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B', 'C']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 1.9);
        expect(r.pruned_count).toBe(2); // max treated as 1
    });

    it('returns section_sizes even when no compaction needed', async () => {
        write(root, 'home/nova/CONTEXT.md', makeContextH2(['A', 'B']));
        const r = await compact(sandbox, '/home/nova/CONTEXT.md', 10);
        expect(typeof r.section_sizes).toBe('object');
    });
});
