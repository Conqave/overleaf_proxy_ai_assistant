import {
  AssistantMessageKind,
  isProposalStatus,
  isReplyKind,
  type ConversationMessage,
} from '../../domain/conversation';
import { AgentTool } from '../../domain/agent-action';
import {
  createReadRecord,
  isDiagnosticLevel,
  type CompileDiagnostic,
  type SearchMatch,
  type ToolRecord,
} from '../../domain/agent-transcript';
import { createDocumentCommand, type DocumentCommand } from '../../domain/document-command';
import {
  InvalidDocumentCommandError,
  InvalidProjectPathError,
  InvalidToolRecordError,
  NamedError,
} from '../../domain/errors';
import { createProjectPath } from '../../domain/project-file';
import type { ConversationSession } from '../../domain/session';
import type { OverleafPageIdentity } from '../overleaf/overleaf-page';

export class UnknownStoredFormatError extends NamedError {}

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
  if (role !== 'assistant') throw new UnknownStoredFormatError('unknown role');
  const kind = fields.get('kind');
  if (kind === AssistantMessageKind.Proposal) {
    const path = parsePath(fields.get('path'));
    const command = parseCommand(fields.get('command'));
    const status = fields.get('status');
    if (!isProposalStatus(status)) throw new UnknownStoredFormatError('unknown proposal status');
    return { id, role, kind, path, command, status };
  }
  if (!isReplyKind(kind)) throw new UnknownStoredFormatError('unknown message kind');
  return { id, role, kind, text: getString(fields, 'text') };
}

function parseRecord(value: unknown): ToolRecord {
  const fields = getFields(value);
  const tool = fields.get('tool');
  switch (tool) {
    case AgentTool.ReadFile:
      return parseReadRecord(fields);
    case AgentTool.Search:
      return {
        tool,
        query: getString(fields, 'query'),
        matches: getArray(fields, 'matches').map(parseMatch),
        truncated: getBoolean(fields, 'truncated'),
      };
    case AgentTool.Compile:
      return { tool, diagnostics: getArray(fields, 'diagnostics').map(parseDiagnostic) };
    default:
      throw new UnknownStoredFormatError('unknown tool record');
  }
}

function parseReadRecord(fields: Map<string, unknown>): ToolRecord {
  const shown = getFields(fields.get('shown'));
  const lines = getArray(fields, 'lines').map((line) => {
    if (typeof line !== 'string') throw new UnknownStoredFormatError('a read line is not text');
    return line;
  });
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

function parseMatch(value: unknown): SearchMatch {
  const fields = getFields(value);
  return {
    path: parsePath(fields.get('path')),
    lineNumber: getLineNumber(fields),
    lineText: getString(fields, 'lineText'),
  };
}

function parseDiagnostic(value: unknown): CompileDiagnostic {
  const fields = getFields(value);
  const level = fields.get('level');
  if (!isDiagnosticLevel(level)) throw new UnknownStoredFormatError('unknown diagnostic level');
  const diagnostic = { level, message: getString(fields, 'message') };
  const path = fields.has('path') ? { path: parsePath(fields.get('path')) } : {};
  const lineNumber = fields.has('lineNumber') ? { lineNumber: getLineNumber(fields) } : {};
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

function getFields(value: unknown): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnknownStoredFormatError('not an object');
  }
  return new Map(Object.entries(value));
}

function getNonNegativeInteger(fields: Map<string, unknown>, key: string): number {
  const value = fields.get(key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UnknownStoredFormatError(`${key} is not a non-negative integer`);
  }
  return value;
}

function getLineNumber(fields: Map<string, unknown>): number {
  const lineNumber = getNonNegativeInteger(fields, 'lineNumber');
  if (lineNumber === 0) throw new UnknownStoredFormatError('lineNumber is not a line number');
  return lineNumber;
}

function getBoolean(fields: Map<string, unknown>, key: string): boolean {
  const value = fields.get(key);
  if (typeof value !== 'boolean') throw new UnknownStoredFormatError(`${key} is not a boolean`);
  return value;
}

function getArray(fields: Map<string, unknown>, key: string): readonly unknown[] {
  const value = fields.get(key);
  if (!Array.isArray(value)) throw new UnknownStoredFormatError(`${key} is not a list`);
  return value;
}

function getString(fields: Map<string, unknown>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string') throw new UnknownStoredFormatError(`${key} is not text`);
  return value;
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
  const messages = parseStoredMessages(fields.get('messages'));
  if (getNonNegativeInteger(fields, 'messageCount') !== messages.length) {
    throw new UnknownStoredFormatError('messageCount does not match the messages');
  }
  const title = getString(fields, 'title');
  if (title === '') throw new UnknownStoredFormatError('title is empty');
  return {
    id: getString(fields, 'id'),
    title,
    createdAt: getNonNegativeInteger(fields, 'createdAt'),
    updatedAt: getNonNegativeInteger(fields, 'updatedAt'),
    messages,
  };
}
