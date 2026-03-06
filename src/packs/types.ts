import type { IPromptContributorRegistry } from '@nucleic-se/gears/agentic';
import type { AgentContext, SpeakAction, DmAction } from '../types.js';
import type { Room } from '../Room.js';

export interface IvyPromptContext {
    [key: string]: unknown;
    handle: string;
    displayName: string;
    context: AgentContext;
}

export interface IvyAgentPackContext {
    promptRegistry: IPromptContributorRegistry<IvyPromptContext>;
}

export interface IvyAgentPack {
    id: string;
    register(ctx: IvyAgentPackContext): void;
}

/** The subset of actions that routing guards can inspect and modify. */
export type RoutableAction = SpeakAction | DmAction;

export interface IvyRoutingGuardContext {
    senderHandle: string;
    senderDisplayName: string;
    action: RoutableAction;
    room: Room;
}

export interface IvyRoutingGuardResult {
    action: RoutableAction | null;
    extraMessages?: RoutableAction[];
}

export interface IvyRoutingGuard {
    id: string;
    inspect(ctx: IvyRoutingGuardContext): IvyRoutingGuardResult | Promise<IvyRoutingGuardResult>;
}

export interface IvyActionHandler {
    type: string;
    handle(action: import('../types.js').AgentAction, agentHandle: string): Promise<string>;
}

export interface IvyParticipantPackContext {
    registerRoutingGuard(guard: IvyRoutingGuard): void;
    registerActionHandler(handler: IvyActionHandler): void;
}

export interface IvyParticipantPack {
    id: string;
    register(ctx: IvyParticipantPackContext): void;
}
