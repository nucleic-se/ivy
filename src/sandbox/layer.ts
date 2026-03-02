import type { FsOp } from '../types.js';

export interface LayerContext {
    op: FsOp;
    /** Normalised absolute agent path (e.g. "/tools/web/fetch.json"). */
    agentPath: string;
    /**
     * Path relative to the layer's mountPath (always starts with "/").
     * "/" means the op targets the mount point itself (e.g. ls /tools/web).
     * "/fetch.json" means a child path (e.g. read /tools/web/fetch.json).
     */
    relPath: string;
    /** Content for write operations. */
    content?: string;
}

export interface SandboxLayer {
    readonly id: string;
    /** Absolute agent-visible mount point (e.g. "/tools/web"). Must start with /. */
    readonly mountPath: string;

    /**
     * Handle a filesystem operation for a path within this layer's mountPath.
     * Return a formatted result string if handled, or null to fall through
     * to the next layer or the physical filesystem.
     */
    handle(ctx: LayerContext): Promise<string | null>;

    /**
     * Invoke a named tool within this layer.
     * Only present on layers that expose callable tools (e.g. ToolGroupLayer).
     */
    callTool?(
        name: string,
        args: Record<string, unknown>,
        qualifiedName: string,
        callerHandle: string,
    ): Promise<string>;

    /**
     * Return a flat list of tool summaries for prompt display.
     * Only present on layers that expose callable tools.
     */
    listTools?(): Array<{ name: string; description: string }>;
}
