import {
  AssistantMessageKind,
  isProposalStatus,
  isReplyKind,
  type ConversationMessage,
} from '../../domain/conversation';
import { createDocumentCommand, type DocumentCommand } from '../../domain/document-command';
import {
  InvalidDocumentCommandError,
  InvalidProjectPathError,
  NamedError,
} from '../../domain/errors';
import { createProjectPath } from '../../domain/project-file';

export class UnknownStoredFormatError extends NamedError {}

export function parseStoredMessages(data: unknown): ConversationMessage[] {
  if (!Array.isArray(data)) throw new UnknownStoredFormatError('not an array');
  return data.map(parseMessage);
}

function parseMessage(value: unknown): ConversationMessage {
  const fields = getFields(value);
  const id = getString(fields, 'id');
  const role = fields.get('role');
  if (role === 'user' || role === 'system') return { id, role, text: getString(fields, 'text') };
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

function getString(fields: Map<string, unknown>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string') throw new UnknownStoredFormatError(`${key} is not text`);
  return value;
}
