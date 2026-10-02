import { AgentTool } from './agent-action';
import { decideEdits, EditStatus, findPendingEdits } from './change-set';
import {
  isUndecidedProposal,
  type ConversationMessage,
  type ImportedHistory,
  type UserMessage,
} from './conversation';
import { countCoveredMessages } from './conversation-view';
import { InvariantViolation } from './errors';
import { carriesWebContent } from './web-search';

export const MAX_SESSION_MESSAGES = 80;
export const MAX_SESSION_TITLE_LENGTH = 80;

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
}

export interface ConversationSession {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly ConversationMessage[];
  readonly imported: ImportedHistory | null;
}

export function createSessionTitle(request: string): string {
  const title = request.replace(/\s+/g, ' ').trim();
  if (title === '') throw new InvariantViolation('a session title needs a non-empty request');
  if (title.length <= MAX_SESSION_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_SESSION_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function startSession(id: string, first: UserMessage, now: number): ConversationSession {
  return {
    id,
    title: createSessionTitle(first.text),
    createdAt: now,
    updatedAt: now,
    messages: [first],
    imported: null,
  };
}

export function appendToSession(
  session: ConversationSession,
  message: ConversationMessage,
  now: number,
): ConversationSession {
  const messages = dropCoveredExcess([...session.messages, message]);
  return { ...session, messages, updatedAt: now };
}

function dropCoveredExcess(messages: ConversationMessage[]): ConversationMessage[] {
  const excess = messages.length - MAX_SESSION_MESSAGES;
  if (excess <= 0) return messages;
  return messages.slice(Math.min(excess, countCoveredMessages(messages)));
}

export function replaceInSession(
  session: ConversationSession,
  message: ConversationMessage,
  now: number,
): ConversationSession {
  if (!session.messages.some((shown) => shown.id === message.id)) {
    throw new InvariantViolation(`session ${session.id} has no message ${message.id}`);
  }
  const messages = session.messages.map((shown) => (shown.id === message.id ? message : shown));
  return { ...session, messages, updatedAt: now };
}

export function holdsUntrustedContent(session: ConversationSession): boolean {
  return session.imported !== null || session.messages.some(carriesWebResults);
}

export function holdsUntrustedContentSince(
  session: ConversationSession,
  messageId: string,
): boolean {
  const index = session.messages.findIndex(({ id }) => id === messageId);
  if (index === -1)
    throw new InvariantViolation(`session ${session.id} has no message ${messageId}`);
  return session.imported !== null || session.messages.slice(index + 1).some(carriesWebResults);
}

function carriesWebResults(message: ConversationMessage): boolean {
  return (
    message.role === 'tool' &&
    message.record.tool === AgentTool.WebSearch &&
    carriesWebContent(message.record.outcome)
  );
}

export function hasUndecidedProposals(session: ConversationSession): boolean {
  return session.messages.some(isUndecidedProposal);
}

export function discardUndecidedProposals(session: ConversationSession): ConversationSession {
  const messages = session.messages.map((message) =>
    isUndecidedProposal(message)
      ? {
          ...message,
          edits: decideEdits(message.edits, findPendingEdits(message.edits), EditStatus.Discarded),
        }
      : message,
  );
  return { ...session, messages };
}

export function summarizeSession(session: ConversationSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

export function sortNewestFirst(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}
