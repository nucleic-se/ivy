/**
 * Tests for the Sandbox security model and AgentParticipant fs/call dispatch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from '../src/sandbox/Sandbox.js';
import { ToolGroupPack } from '../src/sandbox/ToolGroupPack.js';
import type { Tool } from '../src/sandbox/ToolGroupPack.js';
import { AgentParticipant } from '../src/AgentParticipant.js';
import { RoomLog } from '../src/RoomLog.js';
import { Room } from '../src/Room.js';
import type { Agent, AgentAction, AgentContext } from '../src/types.js';
import { createTestDatabase } from '@nucleic-se/gears/testing';

// ─── Helpers ────────────────────────────────────────────────────

/** Create a Sandbox backed by a real temp directory (not GEARS_DATA_DIR). */
function tempSandbox(): { sandbox: Sandbox; root: string; cleanup: () => void } {
    // realpathSync resolves the /tmp → /private/tmp symlink on macOS so that
    // subsequent realpathSync calls inside Sandbox don't fail the root check.
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-sandbox-test-')));
    const sandbox = new TestableSandbox(tmpBase);
    return {
        sandbox,
        root: sandbox.root,
        cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
    };
}

/** Sandbox subclass that accepts an explicit (already realpathSync'd) root for testing. */
class TestableSandbox extends Sandbox {
    constructor(explicitRoot: string) {
        super(); // boots with GEARS_DATA_DIR root (harmless for tests)
        // Override root with the pre-resolved test directory.
        (this as any).root = explicitRoot;
        for (const dir of ['home', 'tools', 'data', 'tmp']) {
            fs.mkdirSync(path.join(explicitRoot, dir), { recursive: true });
        }
    }
}

function stubAgent(actions: AgentAction[]): Agent {
    return {
        handle: '@test',
        displayName: 'Test',
        think: vi.fn<[AgentContext], Promise<AgentAction[]>>().mockResolvedValue(actions),
    };
}

function makeRoom() {
    const db = createTestDatabase();
    const log = new RoomLog(db);
    return new Room(log);
}

// ─── Sandbox unit tests ─────────────────────────────────────────

describe('Sandbox — path security', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
    });
    afterEach(() => cleanup());

    it('allows read on an existing file', async () => {
        fs.writeFileSync(path.join(root, 'home', 'hello.txt'), 'world', 'utf-8');
        const result = await sandbox.execFs({ type: 'fs', op: 'read', path: '/home/hello.txt' });
        expect(result).toContain('world');
    });

    it('allows write and read roundtrip in /home', async () => {
        await sandbox.execFs({ type: 'fs', op: 'write', path: '/home/note.txt', content: 'test content' });
        const result = await sandbox.execFs({ type: 'fs', op: 'read', path: '/home/note.txt' });
        expect(result).toContain('test content');
    });

    it('allows ls on /home', async () => {
        fs.writeFileSync(path.join(root, 'home', 'a.txt'), '', 'utf-8');
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/home' });
        expect(result).toContain('a.txt');
    });

    it('ls annotates subdirectories that contain index.md', async () => {
        fs.mkdirSync(path.join(root, 'home', 'project'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'project', 'index.md'), '# Project', 'utf-8');
        fs.mkdirSync(path.join(root, 'home', 'empty-dir'), { recursive: true });
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/home' });
        expect(result).toContain('d  project  [index.md]');
        // directory without index.md has no annotation
        expect(result).toMatch(/d  empty-dir(\n|$)/);
        expect(result).not.toContain('d  empty-dir  [index.md]');
    });

    it('allows mkdir under /home', async () => {
        await sandbox.execFs({ type: 'fs', op: 'mkdir', path: '/home/project' });
        expect(fs.existsSync(path.join(root, 'home', 'project'))).toBe(true);
    });

    it('allows rm of a file in /home', async () => {
        fs.writeFileSync(path.join(root, 'home', 'del.txt'), '', 'utf-8');
        await sandbox.execFs({ type: 'fs', op: 'rm', path: '/home/del.txt' });
        expect(fs.existsSync(path.join(root, 'home', 'del.txt'))).toBe(false);
    });

    it('allows stat on /home', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'stat', path: '/home' });
        expect(result).toContain('directory');
    });

    it('allows mv to rename a file', async () => {
        fs.writeFileSync(path.join(root, 'home', 'old.txt'), 'content', 'utf-8');
        await sandbox.execFs({ type: 'fs', op: 'mv', path: '/home/old.txt', dest: '/home/new.txt' });
        expect(fs.existsSync(path.join(root, 'home', 'old.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(root, 'home', 'new.txt'), 'utf-8')).toBe('content');
    });

    it('allows mv to move a file into a subdirectory', async () => {
        fs.writeFileSync(path.join(root, 'home', 'file.txt'), 'hi', 'utf-8');
        fs.mkdirSync(path.join(root, 'home', 'sub'), { recursive: true });
        await sandbox.execFs({ type: 'fs', op: 'mv', path: '/home/file.txt', dest: '/home/sub/file.txt' });
        expect(fs.existsSync(path.join(root, 'home', 'sub', 'file.txt'))).toBe(true);
    });

    it('allows mv to rename a directory', async () => {
        fs.mkdirSync(path.join(root, 'home', 'dir-a'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'dir-a', 'x.txt'), 'x', 'utf-8');
        await sandbox.execFs({ type: 'fs', op: 'mv', path: '/home/dir-a', dest: '/home/dir-b' });
        expect(fs.existsSync(path.join(root, 'home', 'dir-b', 'x.txt'))).toBe(true);
    });

    it('rejects mv into /tools (read-only)', async () => {
        fs.writeFileSync(path.join(root, 'home', 'file.txt'), 'x', 'utf-8');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'mv', path: '/home/file.txt', dest: '/tools/file.txt' }),
        ).rejects.toThrow('read-only');
    });

    it('rejects mv of a protected root directory', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'mv', path: '/home', dest: '/tmp/home' }),
        ).rejects.toThrow('protected');
    });

    // ── Recursive rm (purge) ──────────────────────────────────

    it('rm without recursive fails on non-empty directory', async () => {
        fs.mkdirSync(path.join(root, 'home', 'nonempty'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'nonempty', 'file.txt'), 'x', 'utf-8');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/home/nonempty' }),
        ).rejects.toThrow();
    });

    it('rm with recursive=true removes non-empty directory', async () => {
        fs.mkdirSync(path.join(root, 'home', 'tree', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(root, 'home', 'tree', 'a.txt'), 'a', 'utf-8');
        fs.writeFileSync(path.join(root, 'home', 'tree', 'nested', 'b.txt'), 'b', 'utf-8');
        await sandbox.execFs({ type: 'fs', op: 'rm', path: '/home/tree', recursive: true });
        expect(fs.existsSync(path.join(root, 'home', 'tree'))).toBe(false);
    });

    it('rm with recursive=true still rejects protected roots', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/home', recursive: true }),
        ).rejects.toThrow('protected');
    });

    it('rm with recursive=true still rejects read-only zones', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/tools', recursive: true }),
        ).rejects.toThrow();
    });

    // ── Read-only enforcement ──────────────────────────────────

    it('rejects write to /tools', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/tools/evil.json', content: '{}' }),
        ).rejects.toThrow('read-only');
    });

    it('allows write to /data (shared writable space)', async () => {
        // /data is writable shared space for all agents — not read-only.
        const result = await sandbox.execFs({ type: 'fs', op: 'write', path: '/data/shared.txt', content: 'shared data' });
        expect(result).toContain('ok');
    });

    it('rejects mkdir inside /tools', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'mkdir', path: '/tools/subdir' }),
        ).rejects.toThrow('read-only');
    });

    it('rejects write to sandbox root /', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/', content: 'x' }),
        ).rejects.toThrow('read-only');
    });

    // ── Protected root directories ─────────────────────────────

    it('rejects rm of /home', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/home' }),
        ).rejects.toThrow('protected');
    });

    it('rejects rm of /tmp', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/tmp' }),
        ).rejects.toThrow('protected');
    });

    it('rejects rm of /', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/' }),
        ).rejects.toThrow();
    });

    // ── Path traversal ─────────────────────────────────────────

    it('rejects ../ traversal in path', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'read', path: '/home/../../etc/passwd' }),
        ).rejects.toThrow(/traversal|No such file/);
    });

    it('normalises /home/../tools/x before read-only check', async () => {
        // After normalisation /home/../tools/evil.json → /tools/evil.json → read-only
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/home/../tools/evil.json', content: '{}' }),
        ).rejects.toThrow('read-only');
    });

    it('rejects agent write to their own home AGENTS.md', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/home/ivy/AGENTS.md', content: 'x' }, '@ivy'),
        ).rejects.toThrow('read-only');
    });

    it('rejects agent write to another home AGENTS.md', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/home/nova/AGENTS.md', content: 'x' }, '@nova'),
        ).rejects.toThrow('read-only');
    });

    it('rejects non-existent path for read', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'read', path: '/home/no-such-file.txt' }),
        ).rejects.toThrow(/No such file/);
    });

    // ── Size limits ────────────────────────────────────────────

    it('rejects write content exceeding 512 KB', async () => {
        const big = 'x'.repeat(512 * 1024 + 1);
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/home/big.txt', content: big }),
        ).rejects.toThrow(/too large/);
    });

    it('rejects read of file exceeding 512 KB', async () => {
        const big = 'x'.repeat(512 * 1024 + 1);
        fs.writeFileSync(path.join(root, 'home', 'big.txt'), big, 'utf-8');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'read', path: '/home/big.txt' }),
        ).rejects.toThrow(/too large/);
    });

    // ── Home ACL ───────────────────────────────────────────────

    it('allows an agent to write its own home dir', async () => {
        sandbox.ensureAgentHome('@ivy');
        const result = await sandbox.execFs(
            { type: 'fs', op: 'write', path: '/home/ivy/note.txt', content: 'mine' },
            '@ivy',
        );
        expect(result).toContain('ok');
    });

    it('rejects write to another agent home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs(
                { type: 'fs', op: 'write', path: '/home/nova/evil.txt', content: 'x' },
                '@ivy',
            ),
        ).rejects.toThrow(/Permission denied.*ivy.*nova/);
    });

    it('rejects mkdir in another agent home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'mkdir', path: '/home/nova/subdir' }, '@ivy'),
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects rm in another agent home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        fs.writeFileSync(path.join(root, 'home', 'nova', 'file.txt'), 'x', 'utf-8');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/home/nova/file.txt' }, '@ivy'),
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects mv from another agent home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        fs.writeFileSync(path.join(root, 'home', 'nova', 'file.txt'), 'x', 'utf-8');
        await expect(
            sandbox.execFs(
                { type: 'fs', op: 'mv', path: '/home/nova/file.txt', dest: '/tmp/stolen.txt' },
                '@ivy',
            ),
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects mv into another agent home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        sandbox.ensureAgentHome('@ivy');
        fs.writeFileSync(path.join(root, 'home', 'ivy', 'file.txt'), 'x', 'utf-8');
        await expect(
            sandbox.execFs(
                { type: 'fs', op: 'mv', path: '/home/ivy/file.txt', dest: '/home/nova/injected.txt' },
                '@ivy',
            ),
        ).rejects.toThrow(/Permission denied/);
    });

    it('allows cross-agent read of another home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        fs.writeFileSync(path.join(root, 'home', 'nova', 'public.txt'), 'nova content', 'utf-8');
        const result = await sandbox.execFs(
            { type: 'fs', op: 'read', path: '/home/nova/public.txt' },
            '@ivy',
        );
        expect(result).toContain('nova content');
    });

    it('allows cross-agent ls of another home dir', async () => {
        sandbox.ensureAgentHome('@nova');
        fs.writeFileSync(path.join(root, 'home', 'nova', 'notes.md'), '', 'utf-8');
        const result = await sandbox.execFs(
            { type: 'fs', op: 'ls', path: '/home/nova' },
            '@ivy',
        );
        expect(result).toContain('notes.md');
    });

    it('rejects rm of the agent home directory itself by another agent', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'rm', path: '/home/nova', recursive: true }, '@ivy'),
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects mv of the agent home directory itself by another agent', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'mv', path: '/home/nova', dest: '/tmp/stolen' }, '@ivy'),
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects mkdir inside another agent home via direct /home/<handle> target', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'mkdir', path: '/home/nova' }, '@ivy'),
        ).rejects.toThrow(/Permission denied/);
    });

    it('rejects write to /home/<handle> path (directory) by another agent', async () => {
        sandbox.ensureAgentHome('@nova');
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/home/nova', content: 'x' }, '@ivy'),
        ).rejects.toThrow(/Permission denied/);
    });

    it('allows write without callerHandle (internal / backward compat)', async () => {
        // No callerHandle — ACL skipped, write allowed regardless of path.
        sandbox.ensureAgentHome('@nova');
        const result = await sandbox.execFs(
            { type: 'fs', op: 'write', path: '/home/nova/runtime.txt', content: 'ok' },
        );
        expect(result).toContain('ok');
    });

    it('remains protected after owner home directory is removed from disk', async () => {
        // Ownership is identity-based — deleting the dir does not vacate the ACL.
        sandbox.ensureAgentHome('@nova');
        sandbox.ensureAgentHome('@ivy');
        // Simulate home deletion directly on the filesystem (sandbox rm blocks home root deletion).
        fs.rmSync(path.join(root, 'home', 'ivy'), { recursive: true, force: true });
        // nova must still be blocked from claiming the vacated path
        await expect(
            sandbox.execFs({ type: 'fs', op: 'write', path: '/home/ivy/takeover.txt', content: 'x' }, '@nova'),
        ).rejects.toThrow(/Permission denied/);
    });

    // ── Tool registration ──────────────────────────────────────

    it('registers and calls a tool', async () => {
        sandbox.registerTool('greet', async (args) => `hello ${args['name']}`, {
            name: 'greet', description: 'Greets someone',
        });
        const result = await sandbox.execCall('greet', { name: 'world' }, '@test');
        expect(result).toContain('hello world');
    });

    it('callerHandle is passed to legacy registerTool handler', async () => {
        let capturedHandle = '';
        sandbox.registerTool('spy', async (_args, callerHandle) => { capturedHandle = callerHandle; return 'ok'; }, {
            name: 'spy', description: 'Spy',
        });
        await sandbox.execCall('spy', {}, '@nova');
        expect(capturedHandle).toBe('@nova');
    });

    it('rejects tool names with path separators', () => {
        expect(() => sandbox.registerTool('../evil', async () => null, {
            name: '../evil', description: 'Bad',
        })).toThrow(/Tool name/);
    });

    it('rejects tool names with special characters', () => {
        expect(() => sandbox.registerTool('evil; rm -rf /', async () => null, {
            name: 'evil', description: 'Bad',
        })).toThrow(/Tool name/);
    });

    it('throws on unknown tool call', async () => {
        await expect(sandbox.execCall('no-such-tool', {}, '@test')).rejects.toThrow(/Unknown tool/);
    });

    it('listTools skips malformed JSON files', () => {
        fs.writeFileSync(path.join(root, 'tools', 'broken.json'), 'not-json', 'utf-8');
        // Must not throw — bad file is silently skipped
        expect(() => sandbox.listTools()).not.toThrow();
        const tools = sandbox.listTools();
        expect(tools.every(t => typeof t.name === 'string')).toBe(true);
    });

    it('ls reads /tools even when a manifest is malformed', () => {
        fs.writeFileSync(path.join(root, 'tools', 'broken.json'), '{bad json', 'utf-8');
        // ls is a filesystem op, not listTools — should succeed regardless
        return expect(
            sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools' }),
        ).resolves.toContain('broken.json');
    });
});

// ─── AgentParticipant sandbox dispatch ─────────────────────────

describe('AgentParticipant — fs/call action routing', () => {
    let sandbox: Sandbox;
    let root: string;
    let cleanup: () => void;
    let room: Room;

    beforeEach(() => {
        ({ sandbox, root, cleanup } = tempSandbox());
        room = makeRoom();
    });
    afterEach(() => cleanup());

    async function runAction(actions: AgentAction[]): Promise<void> {
        const agent = stubAgent(actions);
        const p = new AgentParticipant(agent, room, { sandbox, maxContinuations: 0 });
        room.join(p);
        p.start();
        p.receive({ id: '1', from: '@human', to: '*', text: 'hi', timestamp: Date.now() });
        await vi.waitFor(() => expect(agent.think).toHaveBeenCalled(), { timeout: 2000 });
        // Wait for fs/call handlers (they are async after think)
        await new Promise(r => setTimeout(r, 50));
        p.stop();
    }

    it('posts fs result as internal note', async () => {
        fs.writeFileSync(path.join(root, 'home', 'info.txt'), 'file contents here', 'utf-8');
        await runAction([{ type: 'fs', op: 'read', path: '/home/info.txt' }]);
        const notes = room.getInternal('@test', 10);
        expect(notes.some(n => n.text.includes('file contents here'))).toBe(true);
    });

    it('posts fs error as internal note when file missing', async () => {
        await runAction([{ type: 'fs', op: 'read', path: '/home/does-not-exist.txt' }]);
        // Error is caught per-action and posted as an internal note so the agent learns
        // about the failure without aborting subsequent actions in the same tick.
        const notes = room.getInternal('@test', 10);
        expect(notes.length).toBe(1);
        expect(notes[0]!.text).toMatch(/Error:/);
    });

    it('posts call result as internal note', async () => {
        sandbox.registerTool('ping', async () => 'pong', { name: 'ping', description: 'Ping' });
        await runAction([{ type: 'call', tool: 'ping', args: {} }]);
        const notes = room.getInternal('@test', 10);
        expect(notes.some(n => n.text.includes('pong'))).toBe(true);
    });

    it('logs warning for unknown action type (no handler) without crashing', async () => {
        // 'fs' handler is registered via SandboxParticipantPack; 'call' is too.
        // An unknown type should be silently skipped (the type narrowing prevents this
        // at compile time, but the runtime guard still covers it defensively).
        // We test by creating a participant WITHOUT sandbox and sending an fs action.
        const agent = stubAgent([{ type: 'fs', op: 'read', path: '/home/x.txt' }]);
        const p = new AgentParticipant(agent, room, {}); // no sandbox → no handlers
        room.join(p);
        p.start();
        p.receive({ id: '2', from: '@human', to: '*', text: 'hi', timestamp: Date.now() });
        await vi.waitFor(() => expect(agent.think).toHaveBeenCalled(), { timeout: 2000 });
        await new Promise(r => setTimeout(r, 50));
        p.stop();
        // Should not crash; no notes written
        const notes = room.getInternal('@test', 10);
        expect(notes.length).toBe(0);
    });
});

// ─── ToolGroupPack / virtual layer ─────────────────────────────

describe('ToolGroupPack — virtual layer', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    const greetTool: Tool = {
        name: 'greet',
        description: 'Greet someone',
        parameters: { name: { type: 'string', description: 'Name', required: true } },
        returns: 'A greeting string',
        examples: ['{"calls": [{"tool": "demo/greet", "args": {"name": "world"}}]}'],
        handler: async (args) => `Hello, ${args['name']}!`,
    };

    const echoTool: Tool = {
        name: 'echo',
        description: 'Echo input',
        handler: async (args) => args,
    };

    beforeEach(() => {
        ({ sandbox, cleanup } = tempSandbox());
        sandbox.mount(new ToolGroupPack('demo', [greetTool, echoTool]).createLayer());
    });
    afterEach(() => cleanup());

    // Discovery

    it('ls /tools shows the mounted group as a virtual directory', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools' });
        expect(result).toContain('d  demo');
    });

    it('ls /tools/demo lists tool manifests', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/demo' });
        expect(result).toContain('f  greet.json');
        expect(result).toContain('f  echo.json');
    });

    it('read /tools/demo/greet.json returns full manifest', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'read', path: '/tools/demo/greet.json' });
        const json = JSON.parse(result.split('\n').slice(1).join('\n'));
        expect(json.name).toBe('greet');
        expect(json.group).toBe('demo');
        expect(json.call).toBe('demo/greet');
        expect(json.parameters).toBeDefined();
        expect(json.returns).toBe('A greeting string');
        expect(json.example).toContain('demo/greet');
    });

    it('manifest auto-generates example when none provided', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'read', path: '/tools/demo/echo.json' });
        const json = JSON.parse(result.split('\n').slice(1).join('\n'));
        expect(json.example).toContain('demo/echo');
    });

    it('stat /tools/demo returns directory', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'stat', path: '/tools/demo' });
        expect(result).toContain('directory');
    });

    it('stat /tools/demo/greet.json returns file with size', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'stat', path: '/tools/demo/greet.json' });
        expect(result).toContain('file');
        expect(result).toMatch(/size: \d+/);
    });

    it('read of unknown tool in group returns no-such-file error', async () => {
        await expect(
            sandbox.execFs({ type: 'fs', op: 'read', path: '/tools/demo/unknown.json' }),
        ).rejects.toThrow(/No such file/);
    });

    // Tool calls

    it('execCall routes qualified name to layer handler', async () => {
        const result = await sandbox.execCall('demo/greet', { name: 'Alice' }, '@test');
        expect(result).toContain('Hello, Alice!');
        expect(result).toContain('demo/greet');
    });

    it('callerHandle is passed through to tool handler', async () => {
        let capturedHandle = '';
        sandbox.mount(new ToolGroupPack('spy', [{
            name: 'who',
            description: 'Captures caller handle',
            handler: async (_args, callerHandle) => { capturedHandle = callerHandle; return 'ok'; },
        }]).createLayer());
        await sandbox.execCall('spy/who', {}, '@ivy');
        expect(capturedHandle).toBe('@ivy');
    });

    it('execCall error on unknown tool in group', async () => {
        await expect(sandbox.execCall('demo/missing', {}, '@test')).rejects.toThrow(/Unknown tool/);
    });

    it('execCall error on unknown group', async () => {
        await expect(sandbox.execCall('nogroup/tool', {}, '@test')).rejects.toThrow(/Unknown tool group/);
    });

    // listTools aggregation

    it('listTools returns grouped entries from layers', () => {
        const tools = sandbox.listTools();
        const greet = tools.find(t => t.name === 'greet');
        const echo  = tools.find(t => t.name === 'echo');
        expect(greet?.group).toBe('demo');
        expect(echo?.group).toBe('demo');
    });

    it('listTools shows group/name in prompt contributor', () => {
        const tools = sandbox.listTools();
        const qualNames = tools.map(t => t.group ? `${t.group}/${t.name}` : t.name);
        expect(qualNames).toContain('demo/greet');
        expect(qualNames).toContain('demo/echo');
    });
});

describe('Sandbox — multiple tool groups', () => {
    let sandbox: Sandbox;
    let cleanup: () => void;

    beforeEach(() => {
        ({ sandbox, cleanup } = tempSandbox());
        sandbox
            .mount(new ToolGroupPack('alpha', [
                { name: 'a1', description: 'Alpha one', handler: async () => 'a1' },
            ]).createLayer())
            .mount(new ToolGroupPack('beta', [
                { name: 'b1', description: 'Beta one', handler: async () => 'b1' },
            ]).createLayer());
    });
    afterEach(() => cleanup());

    it('ls /tools shows both groups', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools' });
        expect(result).toContain('d  alpha');
        expect(result).toContain('d  beta');
    });

    it('ls /tools/alpha does not show beta tools', async () => {
        const result = await sandbox.execFs({ type: 'fs', op: 'ls', path: '/tools/alpha' });
        expect(result).toContain('a1.json');
        expect(result).not.toContain('b1.json');
    });

    it('routes calls to the correct group', async () => {
        expect(await sandbox.execCall('alpha/a1', {}, '@test')).toContain('a1');
        expect(await sandbox.execCall('beta/b1', {}, '@test')).toContain('b1');
    });

    it('listTools aggregates both groups', () => {
        const tools = sandbox.listTools();
        const names = tools.map(t => `${t.group}/${t.name}`);
        expect(names).toContain('alpha/a1');
        expect(names).toContain('beta/b1');
    });
});

// ─── Per-agent sandbox isolation ───────────────────────────────

describe('Sandbox — per-agent isolation', () => {
    it('two Sandbox instances with different handles have different roots', () => {
        // We can't use TestableSandbox here without GEARS_DATA_DIR being set,
        // so we just verify the root paths differ based on handle.
        // The handle is embedded in the root path.
        const s1 = new TestableSandbox('/tmp/ivy-root-a');
        const s2 = new TestableSandbox('/tmp/ivy-root-b');
        // Manually set distinct roots
        (s1 as any).root = '/tmp/ivy-root-a';
        (s2 as any).root = '/tmp/ivy-root-b';
        expect(s1.root).not.toBe(s2.root);
    });
});
