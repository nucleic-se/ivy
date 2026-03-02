import type { IvyParticipantPack, IvyParticipantPackContext } from './types.js';
import type { Sandbox } from '../sandbox/Sandbox.js';
import type { FsAction, CallAction } from '../types.js';

export class SandboxParticipantPack implements IvyParticipantPack {
    id = 'sandbox';

    constructor(private sandbox: Sandbox) {}

    register(ctx: IvyParticipantPackContext): void {
        const sandbox = this.sandbox;

        ctx.registerActionHandler({
            type: 'fs',
            async handle(action, agentHandle): Promise<string> {
                return sandbox.execFs(action as FsAction, agentHandle);
            },
        });

        ctx.registerActionHandler({
            type: 'call',
            async handle(action, agentHandle): Promise<string> {
                const a = action as CallAction;
                return sandbox.execCall(a.tool, a.args ?? {}, agentHandle);
            },
        });
    }
}
