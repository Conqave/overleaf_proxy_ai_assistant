import type { AssistantPlan } from '../domain/assistant-plan';
import type { AssistantReply } from '../domain/assistant-reply';
import type { ConversationMessage } from '../domain/conversation';
import type { DocumentSnapshot } from '../domain/document';

export interface GatheredEvidence {
  readonly document: DocumentSnapshot;
  readonly lineContext?: { readonly firstLineNumber: number; readonly lines: readonly string[] };
  readonly selection?: string;
  readonly logs?: string;
}

export interface PlanningRequest {
  readonly message: string;
  readonly conversation: readonly ConversationMessage[];
}

export interface ReplyRequest {
  readonly message: string;
  readonly plan: AssistantPlan;
  readonly evidence: GatheredEvidence;
  readonly conversation: readonly ConversationMessage[];
}

export interface AssistantPort {
  plan(request: PlanningRequest): Promise<AssistantPlan>;
  reply(request: ReplyRequest): Promise<AssistantReply>;
}
