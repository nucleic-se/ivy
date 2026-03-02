/**
 * Sandbox — isolated filesystem for agent tool use.
 *
 * All paths presented to agents are absolute from the sandbox root
 * (e.g. "/home/notes.md"). Each sandbox instance owns a unique root
 * directory under GEARS_DATA_DIR/sandbox/<agent>/.
 *
 * Layer system
 * ────────────
 * Virtual layers can be mounted on top of the physical filesystem via
 * sandbox.mount(layer). Layers intercept fs ops for their mountPath prefix
 * and return synthetic content (e.g. virtual tool manifests). Ops that no
 * layer handles fall through to the real filesystem.
 *
 * For ls, the result merges physical directory entries with synthetic
 * subdirectory names derived from all layers mounted under that path.
 *
 * Security model
 * ──────────────
 * Security pre-checks run before any layer is consulted and are not
 * bypassable by layer composition:
 * 1. Path normalisation: path.normalize() + path.resolve() rejects ../ traversal.
 * 2. Symlink protection: realpathSync() re-validates existing paths; nearest-
 *    ancestor check covers write targets that don't exist yet.
 * 3. Read-only zones: /, /tools — enforced for write/mkdir/rm. /data is writable shared space.
 * 4. Protected roots: /, /home, /tools, /data, /tmp — enforced for rm.
 * 5. Home ACL: write/mkdir/rm/mv on /home/<handle> or /home/<handle>/... is only allowed for
 *    the owning agent. Ownership is identity-based: a handle is registered via ensureAgentHome()
 *    and protected permanently regardless of directory state. Paths whose first segment is not a
 *    registered handle (e.g. /home/notes.md) are not subject to the check.
 *    Cross-agent reads (/home/<other>/file) are permitted. callerHandle is optional; when
 *    omitted (internal / test use) the check is skipped.
 * 6. Tool name sanitisation: [a-zA-Z0-9_-] only.
 * 7. Size limits: reads capped at 512 KB; write content capped at 512 KB.
 * 8. Resilient tool listing: malformed manifests are silently skipped.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { getDataDir } from 'gears';
import type { FsAction, FsOp } from '../types.js';
import type { ToolManifest } from './types.js';
import type { SandboxLayer } from './layer.js';

const MAX_READ_BYTES  = 512 * 1024;  // 512 KB
const MAX_WRITE_BYTES = 512 * 1024;  // 512 KB

const SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/** Agent-visible path prefixes that agents may not write, mkdir, or rm. */
const READ_ONLY_PREFIXES = ['/', '/tools'] as const;

/** Agent-visible paths that may not be rm'd even if they were writable. */
const PROTECTED_PATHS = ['/', '/home', '/tools', '/data', '/tmp'] as const;

export class Sandbox {
    readonly root: string;

    /** Mounted virtual layers, consulted before the physical filesystem. */
    private layers: SandboxLayer[] = [];

    /** Legacy flat tool handlers (backward compat for registerTool). */
    private toolHandlers = new Map<string, (args: Record<string, unknown>, callerHandle: string) => Promise<unknown>>();

    /**
     * Registered agent handles (without @). Populated by ensureAgentHome.
     * Ownership is identity-based: once registered, a handle is protected
     * regardless of whether the home directory currently exists on disk.
     */
    private readonly agentHomes = new Set<string>();

    /**
     * All agents share a single sandbox root at GEARS_DATA_DIR/sandbox/.
     * Each agent's home directory lives at /home/<handle>/ within that root,
     * created automatically when the agent is first registered.
     * The optional agentHandle parameter is accepted for backward compatibility
     * but is no longer used to scope the root.
     */
    constructor() {
        const rawRoot = path.join(getDataDir(), 'sandbox');
        fsSync.mkdirSync(rawRoot, { recursive: true });
        // Store the canonical path so realpathSync checks always match
        // (e.g. /tmp → /private/tmp on macOS).
        this.root = fsSync.realpathSync(rawRoot);
        this.ensureStructure();
    }

    // ─── Layer API ───────────────────────────────────────────────

    /**
     * Mount a virtual layer into the sandbox filesystem.
     * Layers are consulted in mount order; more specific mountPaths (longer)
     * take priority. Returns this for chaining.
     */
    mount(layer: SandboxLayer): this {
        this.layers.push(layer);
        return this;
    }

    // ─── Filesystem operations ───────────────────────────────────

    async execFs(action: FsAction, callerHandle?: string): Promise<string> {
        // Normalise first so /home/../tools/x → /tools/x before any checks.
        const agentPath = path.normalize(action.path);
        if (!path.isAbsolute(agentPath)) {
            throw new Error(`Sandbox path must be absolute, got: ${action.path}`);
        }
        const tag = `fs:${action.op} ${agentPath}`;

        switch (action.op) {
            case 'read': {
                // Virtual layers serve synthetic files (e.g. tool manifests).
                const layerResult = await this.routeToLayer('read', agentPath);
                if (layerResult !== null) return layerResult;
                // Physical fallback.
                const real = this.resolveExisting(agentPath);
                const st = fsSync.statSync(real);
                if (st.isDirectory()) throw new Error(`Path is a directory: ${agentPath}`);
                if (st.size > MAX_READ_BYTES) {
                    throw new Error(`File too large: ${agentPath} (${st.size} B, limit ${MAX_READ_BYTES} B)`);
                }
                return `${tag} →\n${fsSync.readFileSync(real, 'utf-8')}`;
            }
            case 'ls': {
                // A layer at exactly this path handles the directory listing.
                const layerResult = await this.routeToLayer('ls', agentPath);
                if (layerResult !== null) return layerResult;
                // Physical directory listing merged with synthetic child dirs.
                const real = this.resolveExisting(agentPath);
                const entries = fsSync.readdirSync(real, { withFileTypes: true });
                const physLines = entries.map(e => {
                    const kind = e.isDirectory() ? 'd' : 'f';
                    if (e.isDirectory()) {
                        try {
                            const idx = fsSync.statSync(path.join(real, e.name, 'index.md'));
                            if (!idx.isDirectory()) return `d  ${e.name}  [index.md]`;
                        } catch { /* no index.md */ }
                    }
                    return `${kind}  ${e.name}`;
                });
                // Add virtual subdirs from layers mounted under this path,
                // skipping names that already exist physically.
                const physNames = new Set(entries.map(e => e.name));
                const synthLines = this.syntheticChildDirs(agentPath)
                    .filter(l => !physNames.has(l.slice(3))); // "d  name" → strip 3 chars
                const all = [...physLines, ...synthLines];
                return `${tag} →\n${all.join('\n') || '(empty)'}`;
            }
            case 'stat': {
                const layerResult = await this.routeToLayer('stat', agentPath);
                if (layerResult !== null) return layerResult;
                const real = this.resolveExisting(agentPath);
                const st = fsSync.statSync(real);
                const kind = st.isDirectory() ? 'directory' : 'file';
                return `${tag} → ${kind}, size: ${st.size}, modified: ${st.mtime.toISOString()}`;
            }
            case 'write': {
                this.assertWritable(agentPath, callerHandle);
                const content = action.content ?? '';
                const byteLen = Buffer.byteLength(content, 'utf-8');
                if (byteLen > MAX_WRITE_BYTES) {
                    throw new Error(`Content too large: ${byteLen} B, limit ${MAX_WRITE_BYTES} B`);
                }
                const real = this.resolveForWrite(agentPath);
                fsSync.mkdirSync(path.dirname(real), { recursive: true });
                fsSync.writeFileSync(real, content, 'utf-8');
                return `${tag} → ok`;
            }
            case 'mkdir': {
                this.assertWritable(agentPath, callerHandle);
                const real = this.resolveForWrite(agentPath);
                fsSync.mkdirSync(real, { recursive: true });
                return `${tag} → ok`;
            }
            case 'rm': {
                this.assertNotProtected(agentPath);
                this.assertWritable(agentPath, callerHandle);
                const real = this.resolveExisting(agentPath);
                if (action.recursive) {
                    fsSync.rmSync(real, { recursive: true, force: true });
                } else {
                    // Default: files and empty dirs only — agents must opt in to recursive.
                    fsSync.rmSync(real);
                }
                return `${tag} → ok`;
            }
            case 'mv': {
                const rawDest = path.normalize(action.dest ?? '');
                if (!path.isAbsolute(rawDest)) throw new Error(`Sandbox dest must be absolute, got: ${action.dest}`);
                this.assertNotProtected(agentPath);
                this.assertHomeOwner(agentPath, callerHandle);   // src: no assertWritable for source
                this.assertWritable(rawDest, callerHandle);       // dest: covers home ACL + read-only
                const realSrc  = this.resolveExisting(agentPath);
                const realDest = this.resolveForWrite(rawDest);
                fsSync.mkdirSync(path.dirname(realDest), { recursive: true });
                fsSync.renameSync(realSrc, realDest);
                return `${tag} → ${rawDest}`;
            }
        }
    }

    // ─── Tool calls ──────────────────────────────────────────────

    async execCall(tool: string, args: Record<string, unknown>, callerHandle: string): Promise<string> {
        // Qualified name "group/name" → route to the matching tool group layer.
        const slashIdx = tool.indexOf('/');
        if (slashIdx !== -1) {
            const group = tool.slice(0, slashIdx);
            const name  = tool.slice(slashIdx + 1);
            const groupPath = `/tools/${group}`;
            const layer = this.layers.find(l => l.mountPath === groupPath && l.callTool);
            if (layer?.callTool) {
                return layer.callTool(name, args, tool, callerHandle);
            }
            throw new Error(`Unknown tool group "${group}". Run: fs ls /tools`);
        }
        // Backward compat: flat name registered via registerTool().
        const handler = this.toolHandlers.get(tool);
        if (!handler) {
            const available = [...this.toolHandlers.keys()].join(', ') || 'none';
            throw new Error(`Unknown tool "${tool}". Available: ${available}. Use fs ls /tools to inspect.`);
        }
        const result = await handler(args, callerHandle);
        return `call:${tool} → ${JSON.stringify(result)}`;
    }

    // ─── Tool registry (legacy) ──────────────────────────────────

    /**
     * Register a named tool (legacy flat API).
     * Prefer ToolGroupPack for new tools — it provides virtual manifests,
     * grouped discovery, and richer metadata without writing to disk.
     * Tool names must match [a-zA-Z0-9_-].
     */
    registerTool(
        name: string,
        handler: (args: Record<string, unknown>, callerHandle: string) => Promise<unknown>,
        manifest: ToolManifest,
    ): void {
        if (!SAFE_TOOL_NAME.test(name)) {
            throw new Error(`Tool name must match [a-zA-Z0-9_-], got: "${name}"`);
        }
        this.toolHandlers.set(name, handler);
        const manifestPath = path.join(this.root, 'tools', `${name}.json`);
        fsSync.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    /**
     * Return all tools visible to agents — from virtual layers and legacy
     * disk-based manifests. Used by SandboxToolsContributor to populate
     * the ## Available tools section of the prompt.
     */
    listTools(): Array<{ group?: string; name: string; description: string }> {
        const result: Array<{ group?: string; name: string; description: string }> = [];

        // Virtual layers (ToolGroupPack etc.).
        for (const layer of this.layers) {
            if (!layer.listTools || !layer.mountPath.startsWith('/tools/')) continue;
            const groupName = layer.mountPath.slice('/tools/'.length);
            if (groupName.includes('/')) continue; // skip deeply nested layers
            for (const t of layer.listTools()) {
                result.push({ group: groupName, name: t.name, description: t.description });
            }
        }

        // Legacy disk-based manifests (registerTool).
        const toolsDir = path.join(this.root, 'tools');
        for (const f of fsSync.readdirSync(toolsDir)) {
            if (!f.endsWith('.json')) continue;
            try {
                const raw = fsSync.readFileSync(path.join(toolsDir, f), 'utf-8');
                const m = JSON.parse(raw) as ToolManifest;
                result.push({ name: m.name, description: m.description });
            } catch {
                // Skip malformed manifests — must not crash prompt generation.
            }
        }

        return result;
    }

    // ─── Private: layer routing ──────────────────────────────────

    /**
     * Route an op to the most specific matching virtual layer.
     * Layers sorted by mountPath length (longest first) so more specific
     * mounts win. Returns the layer's result string, or null if no layer
     * handled it (caller should fall through to the physical filesystem).
     */
    private async routeToLayer(op: FsOp, agentPath: string, content?: string): Promise<string | null> {
        const sorted = [...this.layers].sort((a, b) => b.mountPath.length - a.mountPath.length);
        for (const layer of sorted) {
            const { mountPath } = layer;
            if (agentPath !== mountPath && !agentPath.startsWith(mountPath + '/')) continue;
            const relPath = agentPath === mountPath ? '/' : agentPath.slice(mountPath.length);
            const result = await layer.handle({ op, agentPath, relPath, content });
            if (result !== null) return result;
        }
        return null;
    }

    /**
     * Collect "d  <name>" entries for virtual layers mounted as immediate
     * children of parentPath. Used to merge into physical ls results so that
     * virtual subdirectories appear even when the disk directory is empty.
     */
    private syntheticChildDirs(parentPath: string): string[] {
        const prefix = parentPath === '/' ? '/' : parentPath + '/';
        const childNames = new Set<string>();
        for (const layer of this.layers) {
            if (!layer.mountPath.startsWith(prefix)) continue;
            const rest = layer.mountPath.slice(prefix.length);
            const directChild = rest.split('/')[0];
            if (directChild) childNames.add(directChild);
        }
        return [...childNames].sort().map(n => `d  ${n}`);
    }

    // ─── Private: path resolution ────────────────────────────────

    private resolveString(agentPath: string): string {
        const resolved = path.resolve(path.join(this.root, agentPath));
        if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
            throw new Error(`Path traversal rejected: ${agentPath}`);
        }
        return resolved;
    }

    resolveExisting(agentPath: string): string {
        const normalized = this.resolveString(agentPath);
        let real: string;
        try {
            real = fsSync.realpathSync(normalized);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`No such file or directory: ${agentPath}`);
            }
            throw err;
        }
        if (real !== this.root && !real.startsWith(this.root + path.sep)) {
            throw new Error(`Path traversal via symlink rejected: ${agentPath}`);
        }
        return real;
    }

    resolveForWrite(agentPath: string): string {
        const normalized = this.resolveString(agentPath);
        let ancestor = path.dirname(normalized);
        while (ancestor.startsWith(this.root)) {
            try {
                const real = fsSync.realpathSync(ancestor);
                if (real !== this.root && !real.startsWith(this.root + path.sep)) {
                    throw new Error(`Path traversal via symlink rejected: ${agentPath}`);
                }
                break;
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                const parent = path.dirname(ancestor);
                if (parent === ancestor) break;
                ancestor = parent;
            }
        }
        return normalized;
    }

    // ─── Private: policy guards ──────────────────────────────────

    assertWritable(agentPath: string, callerHandle?: string): void {
        for (const prefix of READ_ONLY_PREFIXES) {
            if (agentPath === prefix || agentPath.startsWith(prefix + '/')) {
                throw new Error(`Path is read-only: ${agentPath}`);
            }
        }
        this.assertHomeOwner(agentPath, callerHandle);
    }

    assertNotProtected(agentPath: string): void {
        if ((PROTECTED_PATHS as readonly string[]).includes(agentPath)) {
            throw new Error(`Cannot remove protected sandbox path: ${agentPath}`);
        }
    }

    /**
     * Enforce per-agent home ownership for write operations.
     * /home/<owner> and /home/<owner>/... may only be written by the owning agent.
     * Reads are unrestricted — agents may read each other's home dirs.
     * When callerHandle is omitted (internal use / tests without identity) the check is skipped.
     *
     * Ownership is identity-based, not filesystem-state-based: a handle is protected
     * as soon as it is registered via ensureAgentHome(), and remains protected even
     * if the home directory is later deleted. This prevents a scenario where an agent
     * removes their own home dir and another agent immediately claims the vacated path.
     *
     * Paths whose first segment is not a registered handle (e.g. /home/notes.md) are
     * not subject to the check.
     */
    private assertHomeOwner(agentPath: string, callerHandle?: string): void {
        if (!callerHandle) return;
        if (!agentPath.startsWith('/home/')) return;
        const rest = agentPath.slice('/home/'.length);
        if (!rest) return; // /home/ itself — covered by assertNotProtected
        const slashIdx = rest.indexOf('/');
        const owner = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
        if (!owner) return;
        // Only enforce ownership for registered agent handles.
        // Unregistered path segments (e.g. 'notes.md' in /home/notes.md) are ignored.
        if (!this.agentHomes.has(owner)) return;
        const caller = callerHandle.replace(/^@/, '');
        if (caller !== owner) {
            throw new Error(`Permission denied: @${caller} cannot write to /home/${owner}`);
        }
    }

    // ─── Private: structure ──────────────────────────────────────

    private ensureStructure(): void {
        for (const dir of ['home', 'tools', 'data', 'tmp']) {
            fsSync.mkdirSync(path.join(this.root, dir), { recursive: true });
        }
    }

    /**
     * Ensure an agent's home directory exists at /home/<handle>/.
     * Called by SandboxAgentPack when an agent is registered.
     */
    ensureAgentHome(agentHandle: string): void {
        const handle = agentHandle.replace(/^@/, '');
        this.agentHomes.add(handle);
        fsSync.mkdirSync(path.join(this.root, 'home', handle), { recursive: true });
    }
}
