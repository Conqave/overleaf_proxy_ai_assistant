import type { AgentDecision } from '../domain/agent-action';
import type { AgentTurn, OpenFileView } from '../domain/agent-transcript';
import type { ConversationMessage } from '../domain/conversation';
import type { ProjectFile } from '../domain/project-file';

export interface AgentWorkspace {
  readonly files: readonly ProjectFile[];
  readonly openFile: OpenFileView;
  readonly cursorLine: number;
  readonly selection: string;
}

export interface AgentStepRequest {
  readonly message: string;
  readonly conversation: readonly ConversationMessage[];
  readonly workspace: AgentWorkspace;
  readonly transcript: readonly AgentTurn[];
}

export interface ContextUsage {
  readonly contextTokens: number;
  readonly promptTokens: number;
}

export interface AgentStep {
  readonly decision: AgentDecision;
  readonly contextUsage: ContextUsage;
}

export interface AgentPort {
  decide(request: AgentStepRequest): Promise<AgentStep>;
}
