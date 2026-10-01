import type { DocumentCommand } from './document-command';
import { InvariantViolation } from './errors';

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

export type ReplyKind = Exclude<AssistantMessageKind, typeof AssistantMessageKind.Proposal>;

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

export const ProposalStatus = {
  Proposed: 'proposed',
  Applied: 'applied',
  Rejected: 'rejected',
} as const;
export type ProposalStatus = (typeof ProposalStatus)[keyof typeof ProposalStatus];
export type ProposalDecision = Exclude<ProposalStatus, typeof ProposalStatus.Proposed>;

const PROPOSAL_STATUSES: readonly string[] = Object.values(ProposalStatus);

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === 'string' && PROPOSAL_STATUSES.includes(value);
}

export interface ProposalMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly kind: typeof AssistantMessageKind.Proposal;
  readonly path: string;
  readonly command: DocumentCommand;
  readonly status: ProposalStatus;
}

export function decideProposal(
  message: ProposalMessage,
  decision: ProposalDecision,
): ProposalMessage {
  if (message.status !== ProposalStatus.Proposed) {
    throw new InvariantViolation(`proposal ${message.id} is already ${message.status}`);
  }
  return { ...message, status: decision };
}

export type AssistantMessage = ReplyMessage | ProposalMessage;

export type ConversationMessage = UserMessage | SystemRequestMessage | AssistantMessage;
