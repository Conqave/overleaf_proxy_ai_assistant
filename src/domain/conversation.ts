import type { ToolRecord } from './agent-transcript';
import { hasPendingEdits, type ProposedEdit } from './change-set';

export const AssistantMessageKind = {
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

export interface SystemRequestMessage {
  readonly id: string;
  readonly role: 'system';
  readonly text: string;
}

type ReplyKind = Exclude<AssistantMessageKind, typeof AssistantMessageKind.Proposal>;

const REPLY_KINDS: readonly string[] = Object.values(AssistantMessageKind).filter(
  (kind) => kind !== AssistantMessageKind.Proposal,
);

export function isReplyKind(value: unknown): value is ReplyKind {
  return typeof value === 'string' && REPLY_KINDS.includes(value);
}

export interface ReplyMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: ReplyKind;
  readonly text: string;
}

export interface ProposalMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: typeof AssistantMessageKind.Proposal;
  readonly edits: readonly ProposedEdit[];
}

export interface UndoRefusal {
  readonly path: string;
  readonly problem: string;
}

export interface UndoMessage {
  readonly id: string;
  readonly role: 'undo';
  readonly proposalId: string;
  readonly undone: readonly string[];
  readonly refused: readonly UndoRefusal[];
}

export type AssistantMessage = ReplyMessage | ProposalMessage;

export interface ToolMessage {
  readonly id: string;
  readonly role: 'tool';
  readonly record: ToolRecord;
}

export interface ImportedHistory {
  readonly path: string;
  readonly lastMessageId: string;
}

export interface FileActivity {
  readonly read: readonly string[];
  readonly edited: readonly string[];
}

export interface ConversationSummary {
  readonly text: string;
  readonly files: FileActivity;
  readonly coveredUntilId: string;
  readonly coveredTurns: number;
}

export interface CompactionSummaryMessage extends ConversationSummary {
  readonly id: string;
  readonly role: 'summary';
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly createdAt: string;
}

type RequestMessage = UserMessage | SystemRequestMessage;

export type ChatMessage = RequestMessage | AssistantMessage;

export type ExchangeMessage = ChatMessage | ToolMessage | UndoMessage;

export type ConversationMessage = ExchangeMessage | CompactionSummaryMessage;

export function isRequestMessage(message: ConversationMessage): message is RequestMessage {
  return message.role === 'user' || message.role === 'system';
}

export function isUndecidedProposal(message: ConversationMessage): message is ProposalMessage {
  return (
    message.role === 'assistant' &&
    message.kind === AssistantMessageKind.Proposal &&
    hasPendingEdits(message.edits)
  );
}
