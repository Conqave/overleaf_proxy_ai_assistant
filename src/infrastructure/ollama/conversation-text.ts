import {
  AssistantMessageKind,
  ProposalStatus,
  type AssistantMessage,
  type ConversationMessage,
  type ProposalMessage,
} from '../../domain/conversation';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import { OLDER_RESULT_CHARS } from './context-budget';
import { LINE_BREAK } from './prompt-blocks';
import { describeRecord, renderShortRecord } from './tool-record-text';

export function conversationText(conversation: readonly ConversationMessage[]): string {
  return conversation.map(entryText).join(LINE_BREAK);
}

function entryText(message: ConversationMessage): string {
  switch (message.role) {
    case 'user':
    case 'system':
      return `[${message.role}] ${message.text.trim()}`;
    case 'assistant':
      return `[${message.role}] ${assistantText(message)}`;
    case 'tool':
      return `[${message.role}] ${describeRecord(message.record)}:${LINE_BREAK}${renderShortRecord(message.record, OLDER_RESULT_CHARS)}`;
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
