import { AgentTool } from './agent-action';
import {
  AssistantMessageKind,
  isRequestMessage,
  type CompactionSummaryMessage,
  type ConversationMessage,
  type ConversationSummary,
  type ExchangeMessage,
  type FileActivity,
  type ImportedHistory,
  type ProposalMessage,
} from './conversation';
import { EditStatus } from './change-set';
import { InvalidCompactionSummaryError, InvalidProjectPathError } from './errors';
import { createProjectPath } from './project-file';

export interface ImportedPart {
  readonly path: string;
  readonly messageCount: number;
}

export interface ConversationView {
  readonly summary: ConversationSummary | null;
  readonly messages: readonly ExchangeMessage[];
  readonly imported: ImportedPart | null;
}

export function viewConversation(
  messages: readonly ConversationMessage[],
  imported: ImportedHistory | null,
): ConversationView {
  const latest = findLatestSummary(messages);
  const summary = latest === null ? null : refreshProposals(latest, messages);
  const exchange = messages.slice(countCoveredMessages(messages)).filter(isExchangeMessage);
  if (imported === null) return { summary, messages: exchange, imported: null };
  const messageCount = exchange.findIndex(({ id }) => id === imported.lastMessageId) + 1;
  return { summary, messages: exchange, imported: { path: imported.path, messageCount } };
}

export function getImportedPart(
  view: ConversationView,
  covered: readonly ExchangeMessage[],
): ImportedPart | null {
  if (view.imported === null) return null;
  return {
    path: view.imported.path,
    messageCount: Math.min(view.imported.messageCount, covered.length),
  };
}

export function countCoveredMessages(messages: readonly ConversationMessage[]): number {
  const summary = findLatestSummary(messages);
  if (summary === null) return 0;
  return messages.findIndex((message) => message.id === summary.coveredUntilId) + 1;
}

export function summarizeView(
  view: ConversationView,
  summary: ConversationSummary,
): ConversationView {
  const covered = view.messages.findIndex((message) => message.id === summary.coveredUntilId);
  if (covered === -1) {
    throw new InvalidCompactionSummaryError(
      `the summary covers ${summary.coveredUntilId}, which the conversation does not show`,
    );
  }
  const messages = view.messages.slice(covered + 1);
  if (view.imported === null) return { summary, messages, imported: null };
  const messageCount = Math.max(0, view.imported.messageCount - covered - 1);
  return { summary, messages, imported: { path: view.imported.path, messageCount } };
}

function refreshProposals(
  summary: CompactionSummaryMessage,
  messages: readonly ConversationMessage[],
): CompactionSummaryMessage {
  const stored = new Map(
    messages.filter(isProposalMessage).map((message) => [message.id, message] as const),
  );
  const proposals = summary.proposals.map((proposal) => {
    const current = stored.get(proposal.id);
    return current === undefined ? proposal : current;
  });
  return Object.freeze({ ...summary, proposals: Object.freeze(proposals) });
}

function isProposalMessage(message: ConversationMessage): message is ProposalMessage {
  return message.role === 'assistant' && message.kind === AssistantMessageKind.Proposal;
}

export function createConversationSummary(
  previous: ConversationSummary | null,
  text: string,
  covered: readonly ExchangeMessage[],
): ConversationSummary {
  const last = covered.at(-1);
  if (last === undefined) throw new InvalidCompactionSummaryError('a summary covers no messages');
  const summary = text.trim();
  if (summary === '') throw new InvalidCompactionSummaryError('the summary is empty');
  return Object.freeze({
    text: summary,
    files: collectFileActivity(previous?.files ?? NO_FILE_ACTIVITY, covered),
    proposals: Object.freeze([
      ...(previous === null ? [] : previous.proposals),
      ...covered.filter(isProposalMessage),
    ]),
    coveredUntilId: last.id,
    coveredTurns: (previous?.coveredTurns ?? 0) + covered.filter(isRequestMessage).length,
  });
}

interface CompactionSummaryInput extends ConversationSummary {
  readonly id: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly createdAt: string;
}

export function createCompactionSummaryMessage(
  input: CompactionSummaryInput,
): CompactionSummaryMessage {
  const {
    id,
    text,
    files,
    proposals,
    coveredUntilId,
    coveredTurns,
    tokensBefore,
    tokensAfter,
    createdAt,
  } = input;
  if (id === '' || coveredUntilId === '') {
    throw new InvalidCompactionSummaryError('a summary needs its id and the id it covers until');
  }
  if (text.trim() === '') throw new InvalidCompactionSummaryError('the summary is empty');
  if (![coveredTurns, tokensBefore, tokensAfter].every(isCount)) {
    throw new InvalidCompactionSummaryError('the turns and tokens of a summary are whole numbers');
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidCompactionSummaryError(`the summary date ${createdAt} is no date`);
  }
  return Object.freeze({
    id,
    role: 'summary',
    text,
    files: createFileActivity(files.read, files.edited),
    proposals: Object.freeze([...proposals]),
    coveredUntilId,
    coveredTurns,
    tokensBefore,
    tokensAfter,
    createdAt,
  });
}

export function createFileActivity(
  read: readonly unknown[],
  edited: readonly unknown[],
): FileActivity {
  return Object.freeze({
    read: Object.freeze(read.map(parseActivityPath)),
    edited: Object.freeze(edited.map(parseActivityPath)),
  });
}

const NO_FILE_ACTIVITY: FileActivity = Object.freeze({ read: [], edited: [] });

function collectFileActivity(
  previous: FileActivity,
  covered: readonly ExchangeMessage[],
): FileActivity {
  const read = new Set(previous.read);
  const edited = new Set(previous.edited);
  for (const message of covered) {
    if (message.role === 'tool' && message.record.tool === AgentTool.ReadFile) {
      read.add(message.record.path);
    }
    if (message.role === 'assistant' && message.kind === AssistantMessageKind.Proposal) {
      for (const edit of message.edits) {
        if (edit.status === EditStatus.Applied || edit.status === EditStatus.AppliedBeforeImport) {
          edited.add(edit.path);
        }
      }
    }
  }
  return Object.freeze({ read: Object.freeze([...read]), edited: Object.freeze([...edited]) });
}

function findLatestSummary(
  messages: readonly ConversationMessage[],
): CompactionSummaryMessage | null {
  return messages.findLast((message) => message.role === 'summary') ?? null;
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function parseActivityPath(value: unknown): string {
  try {
    return createProjectPath(value);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError)) throw error;
    throw new InvalidCompactionSummaryError(error.message, { cause: error });
  }
}

function isExchangeMessage(message: ConversationMessage): message is ExchangeMessage {
  return message.role !== 'summary' && message.role !== 'notice';
}
