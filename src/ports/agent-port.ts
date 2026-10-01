import type { AgentDecision } from '../domain/agent-action';
import type { AgentTurn, CompileDiagnostic, OpenFileView } from '../domain/agent-transcript';
import type {
  ConversationMessage,
  SystemRequestMessage,
  UserMessage,
} from '../domain/conversation';
import type { ProjectFile } from '../domain/project-file';
import type { CancellationSignal } from './cancellation';

export interface AgentWorkspace {
  readonly files: readonly ProjectFile[];
  readonly openFile: OpenFileView;
  readonly cursorLine: number;
  readonly selection: string;
}

export interface UserRequest {
  readonly kind: 'user';
  readonly message: UserMessage;
}

export interface CompileFixRequest {
  readonly kind: 'compile-fix';
  readonly message: SystemRequestMessage;
  readonly diagnostics: readonly CompileDiagnostic[];
}

export type AgentRequest = UserRequest | CompileFixRequest;

export interface AgentStepRequest {
  readonly request: AgentRequest;
  readonly conversation: readonly ConversationMessage[];
  readonly workspace: AgentWorkspace;
  readonly transcript: readonly AgentTurn[];
  readonly signal: CancellationSignal;
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
  readonly contextTokens: number;
  decide(request: AgentStepRequest): Promise<AgentStep>;
}
