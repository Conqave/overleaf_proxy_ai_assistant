import type { DocumentCommand } from './document-command';

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

export interface ReplyMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: Exclude<AssistantMessageKind, typeof AssistantMessageKind.Proposal>;
  readonly text: string;
}

export interface ProposalMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: typeof AssistantMessageKind.Proposal;
  readonly command: DocumentCommand;
  readonly rationale?: string;
}

export type AssistantMessage = ReplyMessage | ProposalMessage;

export type ConversationMessage = UserMessage | AssistantMessage;
