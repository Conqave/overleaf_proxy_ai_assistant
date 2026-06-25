export const AssistantMessageKind = {
  Greeting: 'greeting',
  Summary: 'summary',
  Explanation: 'explanation',
  Clarification: 'clarification',
  Proposal: 'proposal',
} as const;
export type AssistantMessageKind = (typeof AssistantMessageKind)[keyof typeof AssistantMessageKind];

export interface UserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly text: string;
}

export type ProposalSummary =
  | {
      readonly operation: 'insert_before' | 'insert_after';
      readonly lineNumber: number;
      readonly lineText: string;
    }
  | {
      readonly operation: 'replace' | 'delete';
      readonly lineNumber: number;
      readonly lineText: string;
      readonly lineCount: number;
    };

export interface ReplyMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: Exclude<AssistantMessageKind, 'proposal'>;
  readonly text: string;
}

export interface ProposalMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: 'proposal';
  readonly text: string;
  readonly plan: string;
  readonly proposal: ProposalSummary;
}

export type AssistantMessage = ReplyMessage | ProposalMessage;

export type ConversationMessage = UserMessage | AssistantMessage;
