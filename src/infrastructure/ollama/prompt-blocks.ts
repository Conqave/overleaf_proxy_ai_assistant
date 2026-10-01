import {
  AssistantMessageKind,
  ProposalStatus,
  type ConversationMessage,
  type GreetingMessage,
  type ProposalMessage,
} from '../../domain/conversation';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import { InvariantViolation } from '../../domain/errors';

const CONVERSATION_WINDOW = 12;
export const SMALL_BLOCK_SHARE = 8;
const MIN_KEPT_CHARS = 32;

export const LINE_BREAK = '\n';
const COMPACT_GAP = LINE_BREAK.repeat(2);
const COMPACT_MARKER_CHARS = compactMarker(Number.MAX_SAFE_INTEGER).length;
const MIN_COMPACT_CHARS = COMPACT_MARKER_CHARS + 2 * MIN_KEPT_CHARS;

const USER_MESSAGE_LABEL = 'User message:';
export const CONVERSATION_LABEL = 'Conversation so far:';
export const SELECTION_LABEL = 'Selected text:';

export function userMessage(message: string): string {
  return `${USER_MESSAGE_LABEL}${LINE_BREAK}${message}`;
}

export function conversationBlock(
  conversation: readonly ConversationMessage[],
  maxChars: number,
): string[] {
  const recent = conversation.filter(isTranscribed).slice(-CONVERSATION_WINDOW);
  if (!recent.length) return [];
  const text = recent
    .map((message) => `[${message.role}] ${transcriptText(message)}`)
    .join(LINE_BREAK);
  return [block(CONVERSATION_LABEL, text, maxChars)];
}

function isTranscribed(
  message: ConversationMessage,
): message is Exclude<ConversationMessage, GreetingMessage> {
  return message.role !== 'assistant' || message.kind !== AssistantMessageKind.Greeting;
}

function transcriptText(message: Exclude<ConversationMessage, GreetingMessage>): string {
  if (message.role !== 'assistant' || message.kind !== AssistantMessageKind.Proposal) {
    return message.text.trim();
  }
  return describeProposal(message);
}

const PROPOSAL_OUTCOME: Record<ProposalStatus, string> = {
  [ProposalStatus.Proposed]: '[proposal left undecided]',
  [ProposalStatus.Applied]: '[proposal applied]',
  [ProposalStatus.Rejected]: '[proposal rejected]',
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

export function block(label: string, text: string, maxChars: number): string {
  const heading = blockHeading(label);
  return `${heading}${compact(text, maxChars - heading.length)}`;
}

export function blockHeading(label: string): string {
  return `${LINE_BREAK}${label}${LINE_BREAK}`;
}

export function minBlockChars(label: string): number {
  return blockHeading(label).length + MIN_COMPACT_CHARS;
}

export function compact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < MIN_COMPACT_CHARS) {
    throw new InvariantViolation(`cannot compact text into ${String(maxChars)} characters`);
  }
  const keep = Math.floor((maxChars - COMPACT_MARKER_CHARS) / 2);
  const omitted = text.length - 2 * keep;
  return `${text.slice(0, keep)}${compactMarker(omitted)}${text.slice(-keep)}`;
}

function compactMarker(omitted: number): string {
  return `${COMPACT_GAP}[AUTOCOMPACTED: omitted ${String(omitted)} chars]${COMPACT_GAP}`;
}

export function lines(...parts: readonly string[]): string {
  return parts.join(LINE_BREAK);
}
