import {
  EditStatus,
  isEditStatus,
  restoreChangeSet,
  type AppliedRecord,
  type ProposedEdit,
} from '../../domain/change-set';
import {
  AssistantMessageKind,
  isReplyKind,
  type CompactionSummaryMessage,
  type ConversationMessage,
  type UndoRefusal,
} from '../../domain/conversation';
import { createCompactionSummaryMessage, createFileActivity } from '../../domain/conversation-view';
import {
  AgentTool,
  createDelegateCall,
  createWebSearchCall,
  type DelegateCall,
  type WebSearchCall,
} from '../../domain/agent-action';
import {
  createReadRecord,
  isDiagnosticLevel,
  type CompileDiagnostic,
  type DelegateRecord,
  type SearchMatch,
  type ToolRecord,
  type WebSearchRecord,
} from '../../domain/agent-transcript';
import {
  createDelegationReport,
  DelegationOutcome,
  type DelegationReport,
} from '../../domain/delegation';
import { createDocumentCommand, type DocumentCommand } from '../../domain/document-command';
import {
  InvalidChangeSetError,
  InvalidCompactionSummaryError,
  InvalidDocumentCommandError,
  InvalidProjectPathError,
  InvalidToolCallError,
  InvalidToolRecordError,
  InvalidWebSearchResultError,
} from '../../domain/errors';
import {
  createWebSearchOutcome,
  WebSearchStatus,
  type WebSearchOutcome,
  type WebSearchResult,
} from '../../domain/web-search';
import { createProjectPath } from '../../domain/project-file';
import type { ConversationSession } from '../../domain/session';
import type { ExportedSession } from '../../domain/session-export';
import type { OverleafPageIdentity } from '../overleaf/overleaf-page';
import {
  getArray,
  getBoolean,
  getFields,
  getNonNegativeInteger,
  getPositiveInteger,
  getString,
  getStrings,
  UnknownStoredFormatError,
} from './stored-fields';

function parseStoredMessages(data: unknown): ConversationMessage[] {
  if (!Array.isArray(data)) throw new UnknownStoredFormatError('not an array');
  return data.map(parseMessage);
}

function parseMessage(value: unknown): ConversationMessage {
  const fields = getFields(value);
  const id = getString(fields, 'id');
  const role = fields.get('role');
  if (role === 'user' || role === 'system') return { id, role, text: getString(fields, 'text') };
  if (role === 'tool') return { id, role, record: parseRecord(fields.get('record')) };
  if (role === 'summary') return parseSummary(id, fields);
  if (role === 'undo') {
    return {
      id,
      role,
      proposalId: getString(fields, 'proposalId'),
      undone: getArray(fields, 'undone').map(parsePath),
      refused: getArray(fields, 'refused').map(parseRefusal),
    };
  }
  if (role !== 'assistant') throw new UnknownStoredFormatError('unknown role');
  const kind = fields.get('kind');
  if (kind === AssistantMessageKind.Proposal) {
    return { id, role, kind, edits: parseEdits(getArray(fields, 'edits')) };
  }
  if (!isReplyKind(kind)) throw new UnknownStoredFormatError('unknown message kind');
  return { id, role, kind, text: getString(fields, 'text') };
}

function parseRefusal(value: unknown): UndoRefusal {
  const fields = getFields(value);
  return { path: parsePath(fields.get('path')), problem: getString(fields, 'problem') };
}

function parseEdits(values: readonly unknown[]): readonly ProposedEdit[] {
  const edits = values.map(parseEdit);
  try {
    return restoreChangeSet(edits);
  } catch (error) {
    if (!(error instanceof InvalidChangeSetError)) throw error;
    throw new UnknownStoredFormatError(`invalid change: ${error.message}`, { cause: error });
  }
}

function parseEdit(value: unknown): ProposedEdit {
  const fields = getFields(value);
  const path = parsePath(fields.get('path'));
  const command = parseCommand(fields.get('command'));
  const status = fields.get('status');
  if (!isEditStatus(status)) throw new UnknownStoredFormatError('unknown edit status');
  if (status === EditStatus.Applied) {
    return { path, command, status, applied: parseApplied(fields.get('applied')) };
  }
  if (fields.has('applied')) {
    throw new UnknownStoredFormatError(`a ${status} edit keeps no applied lines`);
  }
  return { path, command, status };
}

function parseApplied(value: unknown): AppliedRecord {
  const fields = getFields(value);
  const after = getStrings(fields, 'after');
  if (after.length === 0) throw new UnknownStoredFormatError('applied lines are empty');
  return {
    line: getPositiveInteger(fields, 'line'),
    before: getStrings(fields, 'before'),
    after,
    sequence: getNonNegativeInteger(fields, 'sequence'),
  };
}

function parseSummary(id: string, fields: Map<string, unknown>): CompactionSummaryMessage {
  const files = getFields(fields.get('files'));
  try {
    return createCompactionSummaryMessage({
      id,
      text: getString(fields, 'text'),
      files: createFileActivity(getArray(files, 'read'), getArray(files, 'edited')),
      coveredUntilId: getString(fields, 'coveredUntilId'),
      coveredTurns: getNonNegativeInteger(fields, 'coveredTurns'),
      tokensBefore: getNonNegativeInteger(fields, 'tokensBefore'),
      tokensAfter: getNonNegativeInteger(fields, 'tokensAfter'),
      createdAt: getString(fields, 'createdAt'),
    });
  } catch (error) {
    if (!(error instanceof InvalidCompactionSummaryError)) throw error;
    throw new UnknownStoredFormatError(`invalid summary: ${error.message}`, { cause: error });
  }
}

function parseRecord(value: unknown): ToolRecord {
  const fields = getFields(value);
  const tool = fields.get('tool');
  switch (tool) {
    case AgentTool.ReadFile:
      return parseReadRecord(fields);
    case AgentTool.Search: {
      const record = {
        tool,
        query: getString(fields, 'query'),
        matches: getArray(fields, 'matches').map(parseMatch),
        truncated: getBoolean(fields, 'truncated'),
      };
      if (!fields.has('path')) return record;
      return { ...record, path: parsePath(fields.get('path')) };
    }
    case AgentTool.Compile:
      return { tool, diagnostics: getArray(fields, 'diagnostics').map(parseDiagnostic) };
    case AgentTool.Delegate:
      return parseDelegateRecord(fields);
    case AgentTool.WebSearch:
      return parseWebSearchRecord(fields);
    default:
      throw new UnknownStoredFormatError('unknown tool record');
  }
}

function parseReadRecord(fields: Map<string, unknown>): ToolRecord {
  const shown = getFields(fields.get('shown'));
  const lines = getStrings(fields, 'lines');
  try {
    return createReadRecord(
      parsePath(fields.get('path')),
      { first: getNonNegativeInteger(shown, 'first'), last: getNonNegativeInteger(shown, 'last') },
      getNonNegativeInteger(fields, 'totalLines'),
      lines,
    );
  } catch (error) {
    if (!(error instanceof InvalidToolRecordError)) throw error;
    throw new UnknownStoredFormatError(`invalid read record: ${error.message}`, { cause: error });
  }
}

function parseDelegateRecord(fields: Map<string, unknown>): DelegateRecord {
  const call = parseDelegateCall(getString(fields, 'task'), getArray(fields, 'files'));
  return { ...call, report: parseDelegationReport(getFields(fields.get('report'))) };
}

function parseDelegateCall(task: string, files: readonly unknown[]): DelegateCall {
  let call: DelegateCall;
  try {
    call = createDelegateCall(task, files);
  } catch (error) {
    if (!(error instanceof InvalidToolCallError)) throw error;
    throw new UnknownStoredFormatError(`invalid delegation: ${error.message}`, { cause: error });
  }
  if (call.task !== task) throw new UnknownStoredFormatError('the delegated task is not trimmed');
  return call;
}

function parseDelegationReport(fields: Map<string, unknown>): DelegationReport {
  const outcome = fields.get('outcome');
  const lookups = getNonNegativeInteger(fields, 'lookups');
  let report: DelegationReport;
  switch (outcome) {
    case DelegationOutcome.Finished:
      report = {
        outcome,
        text: getString(fields, 'text'),
        truncated: getBoolean(fields, 'truncated'),
        lookups,
      };
      break;
    case DelegationOutcome.Failed:
      report = { outcome, problem: getString(fields, 'problem'), lookups };
      break;
    default:
      throw new UnknownStoredFormatError('unknown delegation outcome');
  }
  try {
    return createDelegationReport(report);
  } catch (error) {
    if (!(error instanceof InvalidToolRecordError)) throw error;
    throw new UnknownStoredFormatError(`invalid delegation report: ${error.message}`, {
      cause: error,
    });
  }
}

function parseWebSearchRecord(fields: Map<string, unknown>): WebSearchRecord {
  const query = getString(fields, 'query');
  let call: WebSearchCall;
  try {
    call = createWebSearchCall(query);
  } catch (error) {
    if (!(error instanceof InvalidToolCallError)) throw error;
    throw new UnknownStoredFormatError(`invalid web search: ${error.message}`, { cause: error });
  }
  if (call.query !== query)
    throw new UnknownStoredFormatError('the web search query is not trimmed');
  return { ...call, outcome: parseWebSearchOutcome(getFields(fields.get('outcome'))) };
}

function parseWebSearchOutcome(fields: Map<string, unknown>): WebSearchOutcome {
  const status = fields.get('status');
  let outcome: WebSearchOutcome;
  switch (status) {
    case WebSearchStatus.Found:
      outcome = {
        status,
        results: getArray(fields, 'results').map(parseWebSearchResult),
        truncated: getBoolean(fields, 'truncated'),
      };
      break;
    case WebSearchStatus.Denied:
      outcome = { status };
      break;
    case WebSearchStatus.Failed:
      outcome = { status, problem: getString(fields, 'problem') };
      break;
    default:
      throw new UnknownStoredFormatError('unknown web search status');
  }
  try {
    return createWebSearchOutcome(outcome);
  } catch (error) {
    if (!(error instanceof InvalidWebSearchResultError)) throw error;
    throw new UnknownStoredFormatError(`invalid web search outcome: ${error.message}`, {
      cause: error,
    });
  }
}

function parseWebSearchResult(value: unknown): WebSearchResult {
  const fields = getFields(value);
  const result = {
    title: getString(fields, 'title'),
    url: getString(fields, 'url'),
    snippet: getString(fields, 'snippet'),
  };
  if (!fields.has('published')) return result;
  return { ...result, published: getString(fields, 'published') };
}

function parseMatch(value: unknown): SearchMatch {
  const fields = getFields(value);
  return {
    path: parsePath(fields.get('path')),
    lineNumber: getPositiveInteger(fields, 'lineNumber'),
    lineText: getString(fields, 'lineText'),
  };
}

function parseDiagnostic(value: unknown): CompileDiagnostic {
  const fields = getFields(value);
  const level = fields.get('level');
  if (!isDiagnosticLevel(level)) throw new UnknownStoredFormatError('unknown diagnostic level');
  const diagnostic = { level, message: getString(fields, 'message') };
  const path = fields.has('path') ? { path: parsePath(fields.get('path')) } : {};
  const lineNumber = fields.has('lineNumber')
    ? { lineNumber: getPositiveInteger(fields, 'lineNumber') }
    : {};
  return { ...diagnostic, ...path, ...lineNumber };
}

function parsePath(value: unknown): string {
  try {
    return createProjectPath(value);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError)) throw error;
    throw new UnknownStoredFormatError(`invalid path: ${error.message}`, { cause: error });
  }
}

function parseCommand(value: unknown): DocumentCommand {
  const fields = getFields(value);
  const input = {
    operation: fields.get('operation'),
    target: fields.get('target'),
    lineCount: fields.get('lineCount'),
    content: fields.get('content'),
    reason: fields.get('reason'),
  };
  try {
    return createDocumentCommand(input);
  } catch (error) {
    if (!(error instanceof InvalidDocumentCommandError)) throw error;
    throw new UnknownStoredFormatError(`invalid command: ${error.message}`, { cause: error });
  }
}

export interface StoredSession {
  readonly userId: string;
  readonly projectId: string;
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly messages: readonly ConversationMessage[];
}

export function toStoredSession(
  session: ConversationSession,
  scope: OverleafPageIdentity,
): StoredSession {
  return {
    userId: scope.userId,
    projectId: scope.projectId,
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    messages: session.messages,
  };
}

export function parseSessionContent(data: unknown): ExportedSession {
  const fields = getFields(data);
  const title = getString(fields, 'title');
  if (title === '') throw new UnknownStoredFormatError('title is empty');
  return {
    title,
    createdAt: getNonNegativeInteger(fields, 'createdAt'),
    updatedAt: getNonNegativeInteger(fields, 'updatedAt'),
    messages: parseStoredMessages(fields.get('messages')),
  };
}

export function parseStoredSession(
  data: unknown,
  scope: OverleafPageIdentity,
): ConversationSession {
  const fields = getFields(data);
  if (getString(fields, 'userId') !== scope.userId) {
    throw new UnknownStoredFormatError('stored for another user');
  }
  if (getString(fields, 'projectId') !== scope.projectId) {
    throw new UnknownStoredFormatError('stored for another project');
  }
  const content = parseSessionContent(data);
  if (getNonNegativeInteger(fields, 'messageCount') !== content.messages.length) {
    throw new UnknownStoredFormatError('messageCount does not match the messages');
  }
  return { id: getString(fields, 'id'), ...content };
}
