import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { JsonToolPack } from '../src/packs/JsonToolPack.js';

// ── Helpers ───────────────────────────────────────────────────────

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
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-json-test-')));
    const sandbox = new TestableSandbox(base);
    sandbox.mount(new JsonToolPack(sandbox).createLayer());
    return {
        sandbox,
        root: base,
        cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    };
}

async function call(sandbox: Sandbox, tool: string, args: Record<string, unknown>): Promise<any> {
    const raw = await sandbox.execCall(`json/${tool}`, args, '@test');
    const arrow = raw.indexOf(' \u2192 ');
    return JSON.parse(raw.slice(arrow + 3));
}

const LEDGER = {
    project: 'Novel-Engine',
    tasks: [
        { id: 'S0_skeleton',  status: 'completed', lock: null,   owner: '@nova' },
        { id: 'S1_arc',       status: 'completed', lock: null,   owner: '@nova' },
        { id: 'S4_expansion', status: 'active',    lock: '@nova', owner: '@nova' },
    ],
    meta: { version: 1 },
};

// ── json/get ──────────────────────────────────────────────────────

describe('json/get', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify(LEDGER, null, 2));
    });
    afterEach(() => cleanup());

    it('reads a top-level string field', async () => {
        const r = await call(sandbox, 'get', { path: '/ledger.json', pointer: '/project' });
        expect(r.found).toBe(true);
        expect(r.value).toBe('Novel-Engine');
    });

    it('reads a nested field via index', async () => {
        const r = await call(sandbox, 'get', { path: '/ledger.json', pointer: '/tasks/2/status' });
        expect(r.found).toBe(true);
        expect(r.value).toBe('active');
    });

    it('reads a null field', async () => {
        const r = await call(sandbox, 'get', { path: '/ledger.json', pointer: '/tasks/0/lock' });
        expect(r.found).toBe(true);
        expect(r.value).toBe(null);
    });

    it('returns { found: false } for a missing key', async () => {
        const r = await call(sandbox, 'get', { path: '/ledger.json', pointer: '/nonexistent' });
        expect(r.found).toBe(false);
        expect(r.value).toBe(null);
    });

    it('returns the full document for the root pointer ""', async () => {
        const r = await call(sandbox, 'get', { path: '/ledger.json', pointer: '' });
        expect(r.found).toBe(true);
        expect(r.value).toMatchObject({ project: 'Novel-Engine' });
    });

    it('resolves find-by-key: /tasks[id=S4_expansion]/status', async () => {
        const r = await call(sandbox, 'get', {
            path: '/ledger.json',
            pointer: '/tasks[id=S4_expansion]/status',
        });
        expect(r.found).toBe(true);
        expect(r.value).toBe('active');
    });

    it('find-by-key returns { found: false } when no match', async () => {
        const r = await call(sandbox, 'get', {
            path: '/ledger.json',
            pointer: '/tasks[id=missing]/status',
        });
        expect(r.found).toBe(false);
    });

    it('reads a deeply nested numeric field', async () => {
        const r = await call(sandbox, 'get', { path: '/ledger.json', pointer: '/meta/version' });
        expect(r.found).toBe(true);
        expect(r.value).toBe(1);
    });

    it('throws on a missing file', async () => {
        await expect(
            call(sandbox, 'get', { path: '/no-such.json', pointer: '/x' })
        ).rejects.toThrow();
    });
});

// ── json/set ──────────────────────────────────────────────────────

describe('json/set', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;
    let ledgerPath: string;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        ledgerPath = path.join(root, 'ledger.json');
        fs.writeFileSync(ledgerPath, JSON.stringify(LEDGER, null, 2));
    });
    afterEach(() => cleanup());

    it('updates a scalar field', async () => {
        await call(sandbox, 'set', { path: '/ledger.json', pointer: '/project', value: 'Updated' });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.project).toBe('Updated');
    });

    it('preserves sibling fields when updating one key', async () => {
        await call(sandbox, 'set', { path: '/ledger.json', pointer: '/meta/version', value: 2 });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.meta.version).toBe(2);
        expect(data.project).toBe('Novel-Engine');
        expect(data.tasks).toHaveLength(3);
    });

    it('sets a nested array element field by index', async () => {
        await call(sandbox, 'set', {
            path: '/ledger.json',
            pointer: '/tasks/2/status',
            value: 'completed',
        });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.tasks[2].status).toBe('completed');
        expect(data.tasks[2].lock).toBe('@nova'); // unchanged
    });

    it('sets via find-by-key: /tasks[id=S4_expansion]/lock', async () => {
        await call(sandbox, 'set', {
            path: '/ledger.json',
            pointer: '/tasks[id=S4_expansion]/lock',
            value: null,
        });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        const task = data.tasks.find((t: any) => t.id === 'S4_expansion');
        expect(task.lock).toBe(null);
        expect(task.status).toBe('active'); // unchanged
    });

    it('creates a new top-level key', async () => {
        await call(sandbox, 'set', { path: '/ledger.json', pointer: '/updated_at', value: '2026-03-02' });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.updated_at).toBe('2026-03-02');
    });

    it('creates the file if it does not exist', async () => {
        await call(sandbox, 'set', { path: '/new.json', pointer: '/state', value: 'init' });
        const data = JSON.parse(fs.readFileSync(path.join(root, 'new.json'), 'utf-8'));
        expect(data.state).toBe('init');
    });

    it('replaces the root document when pointer is ""', async () => {
        await call(sandbox, 'set', { path: '/ledger.json', pointer: '', value: { rebuilt: true } });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data).toEqual({ rebuilt: true });
    });

    it('sets a value to null explicitly', async () => {
        await call(sandbox, 'set', { path: '/ledger.json', pointer: '/tasks/0/owner', value: null });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.tasks[0].owner).toBe(null);
    });

    it('returns { ok: true }', async () => {
        const r = await call(sandbox, 'set', { path: '/ledger.json', pointer: '/project', value: 'X' });
        expect(r.ok).toBe(true);
    });
});

// ── json/del ──────────────────────────────────────────────────────

describe('json/del', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;
    let ledgerPath: string;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        ledgerPath = path.join(root, 'ledger.json');
        fs.writeFileSync(ledgerPath, JSON.stringify(LEDGER, null, 2));
    });
    afterEach(() => cleanup());

    it('removes a top-level key', async () => {
        await call(sandbox, 'del', { path: '/ledger.json', pointer: '/meta' });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.meta).toBeUndefined();
        expect(data.project).toBe('Novel-Engine');
    });

    it('removes a nested key', async () => {
        await call(sandbox, 'del', { path: '/ledger.json', pointer: '/tasks/0/lock' });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(Object.prototype.hasOwnProperty.call(data.tasks[0], 'lock')).toBe(false);
    });

    it('removes an array element by index (splices, shrinks array)', async () => {
        await call(sandbox, 'del', { path: '/ledger.json', pointer: '/tasks/1' });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.tasks).toHaveLength(2);
        expect(data.tasks[0].id).toBe('S0_skeleton');
        expect(data.tasks[1].id).toBe('S4_expansion');
    });

    it('removes an element via find-by-key', async () => {
        await call(sandbox, 'del', { path: '/ledger.json', pointer: '/tasks[id=S1_arc]' });
        const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        expect(data.tasks).toHaveLength(2);
        expect(data.tasks.find((t: any) => t.id === 'S1_arc')).toBeUndefined();
    });

    it('returns { found: false } for a missing key without modifying the file', async () => {
        const before = fs.readFileSync(ledgerPath, 'utf-8');
        const r = await call(sandbox, 'del', { path: '/ledger.json', pointer: '/nonexistent' });
        const after = fs.readFileSync(ledgerPath, 'utf-8');
        expect(r.found).toBe(false);
        expect(r.ok).toBe(true);
        expect(before).toBe(after);
    });

    it('returns { found: false } on a missing file', async () => {
        const r = await call(sandbox, 'del', { path: '/ghost.json', pointer: '/x' });
        expect(r.found).toBe(false);
        expect(r.ok).toBe(true);
    });
});

// ── json/validate ─────────────────────────────────────────────────

describe('json/validate', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => ({ sandbox, root, cleanup } = tempSandbox()));
    afterEach(() => cleanup());

    it('returns { valid: true } for a conforming document', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({ name: 'Alice', age: 30 }));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({
            type: 'object',
            required: ['name', 'age'],
            properties: {
                name: { type: 'string' },
                age:  { type: 'integer', minimum: 0 },
            },
        }));
        const r = await call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' });
        expect(r.valid).toBe(true);
        expect(r.errors).toBeUndefined();
    });

    it('returns { valid: false, errors } for a non-conforming document', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({ age: -1 }));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string' },
                age:  { type: 'integer', minimum: 0 },
            },
        }));
        const r = await call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' });
        expect(r.valid).toBe(false);
        expect(r.errors).toHaveLength(2); // missing 'name' + age < minimum
    });

    it('reports type mismatches', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({ count: 'oops' }));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({
            properties: { count: { type: 'integer' } },
        }));
        const r = await call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].path).toBe('/count');
        expect(r.errors[0].message).toMatch(/type/);
    });

    it('reports enum violations', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({ status: 'unknown' }));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({
            properties: { status: { enum: ['active', 'done'] } },
        }));
        const r = await call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].message).toMatch(/enum/);
    });

    it('reports additionalProperties: false violations', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({ name: 'Bob', extra: true }));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({
            type: 'object',
            properties: { name: { type: 'string' } },
            additionalProperties: false,
        }));
        const r = await call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].message).toMatch(/additional/);
    });

    it('validates array items', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify([1, 2, 'three']));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({
            type: 'array',
            items: { type: 'integer' },
        }));
        const r = await call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].path).toBe('/2');
    });

    it('throws for a missing data file', async () => {
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({ type: 'object' }));
        await expect(
            call(sandbox, 'validate', { path: '/no-such.json', schema: '/schema.json' })
        ).rejects.toThrow();
    });

    it('throws when schema file is not a JSON object', async () => {
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({}));
        fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify([1, 2, 3]));
        await expect(
            call(sandbox, 'validate', { path: '/data.json', schema: '/schema.json' })
        ).rejects.toThrow(/Schema.*must be a JSON object/);
    });
});

// ── Home ACL ──────────────────────────────────────────────────────

describe('json/set and json/del — home ACL', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        sandbox.ensureAgentHome('@nova');
        sandbox.ensureAgentHome('@test');
        fs.writeFileSync(
            path.join(root, 'home', 'nova', 'state.json'),
            JSON.stringify({ locked: true }),
        );
    });
    afterEach(() => cleanup());

    it('rejects json/set to another agent home', async () => {
        await expect(
            call(sandbox, 'set', { path: '/home/nova/state.json', pointer: '/locked', value: false })
        ).rejects.toThrow(/Permission denied/);
    });

    it('allows json/set to own home', async () => {
        const r = await call(sandbox, 'set', { path: '/home/test/data.json', pointer: '/x', value: 1 });
        expect(r.ok).toBe(true);
    });

    it('rejects json/del to another agent home', async () => {
        await expect(
            call(sandbox, 'del', { path: '/home/nova/state.json', pointer: '/locked' })
        ).rejects.toThrow(/Permission denied/);
    });
});
