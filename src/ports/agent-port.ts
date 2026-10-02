import type { AgentDecision } from '../domain/agent-action';
import type { AgentPolicy } from '../domain/agent-policy';
import type { AgentTurn, CompileDiagnostic, OpenFileView } from '../domain/agent-transcript';
import type { ExchangeMessage, SystemRequestMessage, UserMessage } from '../domain/conversation';
import type { ContextUsage } from '../domain/context-usage';
import type { ConversationView } from '../domain/conversation-view';
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

export interface SubtaskRequest {
  readonly kind: 'subtask';
  readonly task: string;
  readonly files: readonly string[];
}

export type ConversationRequest = UserRequest | CompileFixRequest;

export type AgentRequest = ConversationRequest | SubtaskRequest;

export interface AgentStepRequest {
  readonly request: AgentRequest;
  readonly policy: AgentPolicy;
  readonly conversation: ConversationView;
  readonly workspace: AgentWorkspace;
  readonly transcript: readonly AgentTurn[];
  readonly signal: CancellationSignal;
}

export interface AgentStep {
  readonly decision: AgentDecision;
  readonly contextUsage: ContextUsage;
}

export type CompactionTrigger =
  | { readonly kind: 'auto'; readonly step: AgentStepRequest }
  | { readonly kind: 'overflow'; readonly step: AgentStepRequest }
  | { readonly kind: 'manual'; readonly conversation: ConversationView };

export interface CompactionPlan {
  readonly covered: readonly ExchangeMessage[];
}

export interface AgentPort {
  readonly idleUsage: ContextUsage;
  decide(request: AgentStepRequest): Promise<AgentStep>;
  decideShortened(request: AgentStepRequest): Promise<AgentStep>;
  planCompaction(trigger: CompactionTrigger): CompactionPlan | null;
  measureConversation(conversation: ConversationView): number;
}
