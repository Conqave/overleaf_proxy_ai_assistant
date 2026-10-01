import {
  AssistantMessageKind,
  ProposalStatus,
  type AssistantMessage,
  type ConversationSummary,
  type ExchangeMessage,
  type ProposalMessage,
} from '../../domain/conversation';
import type { ConversationView } from '../../domain/conversation-view';
import type { ToolRecord } from '../../domain/agent-transcript';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import { OLDER_RESULT_CHARS } from './context-budget';
import { renderUnlessOutdated } from './outdated-reads';
import { LINE_BREAK, lines } from './prompt-blocks';
import { describeRecord, renderShortRecord } from './tool-record-text';

const OLDER_RESULT_SHORTENED = 'repeat the lookup to see it whole';

export function conversationText(
  conversation: ConversationView,
  outdated: ReadonlySet<ToolRecord>,
): string {
  const summary = conversation.summary === null ? [] : [summaryText(conversation.summary)];
  return lines(...summary, ...conversation.messages.map((message) => entryText(message, outdated)));
}

export function getViewRecords(conversation: ConversationView): ToolRecord[] {
  return getRecords(conversation.messages);
}

export function getRecords(messages: readonly ExchangeMessage[]): ToolRecord[] {
  return messages.flatMap((message) => (message.role === 'tool' ? [message.record] : []));
}

export function summaryText({ text, files, coveredTurns }: ConversationSummary): string {
  return lines(
    `[summary of the ${String(coveredTurns)} earlier turns]`,
    text,
    `Files read: ${files.read.length ? files.read.join(', ') : 'none'}`,
    `Files edited: ${files.edited.length ? files.edited.join(', ') : 'none'}`,
  );
}

export function entryText(message: ExchangeMessage, outdated: ReadonlySet<ToolRecord>): string {
  switch (message.role) {
    case 'user':
    case 'system':
      return `[${message.role}] ${message.text.trim()}`;
    case 'assistant':
      return `[${message.role}] ${assistantText(message)}`;
    case 'tool':
      return `[${message.role}] ${describeRecord(message.record)}:${LINE_BREAK}${renderUnlessOutdated(
        message.record,
        outdated,
        (record) => renderShortRecord(record, OLDER_RESULT_CHARS, OLDER_RESULT_SHORTENED),
      )}`;
  }
}

function assistantText(message: AssistantMessage): string {
  if (message.kind !== AssistantMessageKind.Proposal) return message.text.trim();
  return describeProposal(message);
}

const PROPOSAL_OUTCOME: Record<ProposalStatus, string> = {
  [ProposalStatus.Proposed]: '[proposal left undecided]',
  [ProposalStatus.Applied]: '[proposal applied]',
  [ProposalStatus.Rejected]: '[proposal rejected]',
  [ProposalStatus.Failed]: '[proposal failed to apply]',
  [ProposalStatus.Discarded]: '[proposal discarded without a decision]',
};

function describeProposal({ status, path, command }: ProposalMessage): string {
  const proposed = `${PROPOSAL_OUTCOME[status]} ${path} ${describeLines(command)}: ${command.operation}`;
  const summary = command.reason === undefined ? proposed : `${proposed} (${command.reason})`;
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
    case DocumentOperation.Replace:
      return `${summary}\n${command.content}`;
    case DocumentOperation.Delete:
      return summary;
  }
}

function describeLines(command: DocumentCommand): string {
  const first = command.target.lineNumber;
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return `line ${String(first)}`;
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      if (command.lineCount === 1) return `line ${String(first)}`;
      return `lines ${String(first)}-${String(first + command.lineCount - 1)}`;
  }
}
