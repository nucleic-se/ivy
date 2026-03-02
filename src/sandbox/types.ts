export interface ToolManifest {
    name: string;
    description: string;
    argsSchema?: Record<string, unknown>;
    examples?: string[];
}
