import {
  AssistantMessageKind,
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
import type { ConversationRepository } from '../../ports/conversation-repository';
import { PersistenceError } from '../../ports/errors';
import type { OverleafPageIdentity } from '../overleaf/overleaf-page';

type StorageAction = 'read' | 'save' | 'clear';

class UnknownStoredFormatError extends NamedError {}

export class LocalStorageConversationRepository implements ConversationRepository {
  private readonly key: string;

  constructor(
    private readonly window: Pick<Window, 'localStorage'>,
    scope: OverleafPageIdentity,
  ) {
    this.key = `ola-conversation:${scope.userId}:${scope.projectId}`;
  }

  load(): ConversationMessage[] {
    const raw = this.access('read', (storage) => storage.getItem(this.key));
    if (raw === null) return [];
    try {
      return parseMessages(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new PersistenceError('The saved conversation is corrupted and was not loaded.', {
          cause: error,
        });
      }
      if (error instanceof UnknownStoredFormatError) {
        throw new PersistenceError(
          'The saved conversation has an unknown format and was not loaded.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  save(messages: readonly ConversationMessage[]): void {
    this.access('save', (storage) => {
      storage.setItem(this.key, JSON.stringify(messages));
    });
  }

  clear(): void {
    this.access('clear', (storage) => {
      storage.removeItem(this.key);
    });
  }

  private access<T>(action: StorageAction, operation: (storage: Storage) => T): T {
    try {
      return operation(this.window.localStorage);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      throw new PersistenceError(`Could not ${action} the conversation history.`, {
        cause: error,
      });
    }
  }
}

function parseMessages(data: unknown): ConversationMessage[] {
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
    return { id, role, kind, path, command };
  }
  if (kind === AssistantMessageKind.Greeting) return { id, role, kind };
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
