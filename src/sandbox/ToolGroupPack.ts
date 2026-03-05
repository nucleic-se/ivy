/**
 * ToolGroupPack — mounts a named group of callable tools as a virtual
 * read-only directory at /tools/<groupName>/ in the sandbox.
 *
 * Discovery flow for agents:
 *   fs ls /tools                         → lists group directories
 *   fs ls /tools/<group>                 → lists <tool>.json files
 *   fs read /tools/<group>/<tool>.json   → full manifest with call example
 *   call: { tool: "<group>/<tool>", args: { ... } }
 */

import type { SandboxLayer, LayerContext } from './layer.js';

// ─── Public interfaces ───────────────────────────────────────────

export interface ToolParam {
    type: string;
    description: string;
    required?: boolean;
    enum?: unknown[];
    default?: unknown;
}

export interface Tool {
    name: string;
    description: string;
    /** JSON-Schema-style parameter map. Agents read this before calling. */
    parameters?: Record<string, ToolParam>;
    /** One-line description of what the tool returns. */
    returns?: string;
    /**
     * Ready-to-copy call examples shown in the manifest.
     * If omitted a minimal skeleton is generated automatically.
     */
    examples?: string[];
    handler: (args: Record<string, unknown>, callerHandle: string) => Promise<unknown>;
}

// ─── Internal manifest shape (what agents see in the JSON file) ──

interface ToolManifestJson {
    name: string;
    group: string;
    description: string;
    /** Qualified tool name to use in the call action: "<group>/<name>". */
    call: string;
    parameters?: Record<string, ToolParam>;
    returns?: string;
    /** A ready-to-use call action example. */
    example: string;
}

const SAFE_GROUP_NAME = /^[a-zA-Z0-9_-]+$/;

// ─── Layer ───────────────────────────────────────────────────────

class ToolGroupLayer implements SandboxLayer {
    readonly id: string;
    readonly mountPath: string;
    private readonly toolMap: Map<string, Tool>;

    constructor(private readonly groupName: string, tools: Tool[]) {
        this.id = `tool-group:${groupName}`;
        this.mountPath = `/tools/${groupName}`;
        this.toolMap = new Map(tools.map(t => [t.name, t]));
    }

    async handle(ctx: LayerContext): Promise<string | null> {
        const { op, agentPath, relPath } = ctx;
        const tag = `fs:${op} ${agentPath}`;

        switch (op) {
            case 'ls': {
                if (relPath !== '/') return null;
                const lines = [...this.toolMap.keys()].sort().map(n => `f  ${n}.json`);
                return `${tag} →\n${lines.join('\n') || '(empty)'}`;
            }
            case 'read': {
                const name = this.toolNameFromRel(relPath);
                if (!name) return null;
                const tool = this.toolMap.get(name);
                if (!tool) return null;
                return `${tag} →\n${JSON.stringify(this.buildManifest(tool), null, 2)}`;
            }
            case 'stat': {
                if (relPath === '/') {
                    return `${tag} → directory`;
                }
                const name = this.toolNameFromRel(relPath);
                if (name && this.toolMap.has(name)) {
                    const size = Buffer.byteLength(
                        JSON.stringify(this.buildManifest(this.toolMap.get(name)!), null, 2),
                        'utf-8',
                    );
                    return `${tag} → file, size: ${size}, modified: (virtual)`;
                }
                return null;
            }
            default:
                // write, mkdir, rm are blocked upstream by security guards.
                return null;
        }
    }

    async callTool(name: string, args: Record<string, unknown>, qualifiedName: string, callerHandle: string): Promise<string> {
        const tool = this.toolMap.get(name);
        if (!tool) {
            const available = [...this.toolMap.keys()].sort().join(', ') || 'none';
            throw new Error(
                `Unknown tool "${qualifiedName}". In group "${this.groupName}": ${available}. ` +
                `Run: fs ls /tools/${this.groupName}`,
            );
        }
        // Validate required params before calling the handler.
        if (tool.parameters) {
            const missing = Object.entries(tool.parameters)
                .filter(([k, p]) => p.required && args[k] === undefined)
                .map(([k]) => k);
            if (missing.length > 0) {
                const hints: string[] = [];
                if (missing.includes('path')) hints.push('"path": use text/tree or text/find to discover it first');
                if (missing.includes('content')) hints.push('"content": read the file first with text/read, then supply the full text');
                if (missing.includes('description')) hints.push('"description": provide a one-line summary of what the file contains or does');
                const hintStr = hints.length > 0 ? ` — hints: ${hints.join('; ')}` : '';
                throw new Error(`missing required argument${missing.length > 1 ? 's' : ''}: ${missing.map(k => `"${k}"`).join(', ')}${hintStr}`);
            }
        }
        const result = await tool.handler(args, callerHandle);
        return `call:${qualifiedName} → ${JSON.stringify(result)}`;
    }

    listTools(): Array<{ name: string; description: string }> {
        return [...this.toolMap.values()].map(t => ({ name: t.name, description: t.description }));
    }

    // ── Helpers ─────────────────────────────────────────────────

    /**
     * Extract the tool name from a relative path like "/fetch.json".
     * Returns null for anything that doesn't look like a direct child manifest.
     */
    private toolNameFromRel(relPath: string): string | null {
        if (!relPath.startsWith('/') || !relPath.endsWith('.json')) return null;
        const name = relPath.slice(1, -5); // strip leading / and trailing .json
        // Reject sub-paths (e.g. "/sub/tool.json") and empty strings.
        return name && !name.includes('/') ? name : null;
    }

    private buildManifest(tool: Tool): ToolManifestJson {
        const qualifiedName = `${this.groupName}/${tool.name}`;
        const manifest: ToolManifestJson = {
            name: tool.name,
            group: this.groupName,
            description: tool.description,
            call: qualifiedName,
            example: tool.examples?.[0] ??
                `{"calls": [{"tool": "${qualifiedName}", "args": {}}]}`,
        };
        if (tool.parameters) manifest.parameters = tool.parameters;
        if (tool.returns) manifest.returns = tool.returns;
        return manifest;
    }
}

// ─── Pack ────────────────────────────────────────────────────────

/**
 * Pack that registers a named group of tools as a virtual layer at
 * /tools/<groupName>/ inside the sandbox.
 *
 * Usage:
 *   sandbox.mount(new ToolGroupPack('web', [fetchTool, scrapeTool]).createLayer());
 */
export class ToolGroupPack {
    constructor(
        readonly groupName: string,
        private readonly tools: Tool[],
    ) {
        if (!SAFE_GROUP_NAME.test(groupName)) {
            throw new Error(`Tool group name must match [a-zA-Z0-9_-], got: "${groupName}"`);
        }
    }

    createLayer(): SandboxLayer {
        return new ToolGroupLayer(this.groupName, this.tools);
    }
}
