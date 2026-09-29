import {
  DocumentOperation,
  type AnchorOperation,
  type DocumentCommand,
  type RangeOperation,
} from './document-command';
import type { DocumentTarget } from './document-target';

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

export type ProposalSummary = DocumentTarget &
  (
    | { readonly operation: AnchorOperation }
    | { readonly operation: RangeOperation; readonly lineCount: number }
  );

export function summarizeProposal(command: DocumentCommand): ProposalSummary {
  const { lineNumber, lineText } = command.target;
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return { operation: command.operation, lineNumber, lineText };
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      return { operation: command.operation, lineNumber, lineText, lineCount: command.lineCount };
  }
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
  readonly text: string;
  readonly plan: string;
  readonly proposal: ProposalSummary;
}

export type AssistantMessage = ReplyMessage | ProposalMessage;

export type ConversationMessage = UserMessage | AssistantMessage;
