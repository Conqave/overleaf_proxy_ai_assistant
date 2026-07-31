import {
  AssistantMessageKind,
  type ConversationMessage,
  type ProposalSummary,
  type ReplyMessage,
} from '../../domain/conversation';
import { DocumentOperation } from '../../domain/document-command';
import type { ConversationRepository } from '../../ports/conversation-repository';
import { PersistenceError } from '../../ports/errors';

export interface ConversationScope {
  readonly userId: string;
  readonly projectId: string;
}

function isReplyKind(value: unknown): value is ReplyMessage['kind'] {
  return (
    value === AssistantMessageKind.Greeting ||
    value === AssistantMessageKind.Summary ||
    value === AssistantMessageKind.Explanation ||
    value === AssistantMessageKind.Clarification
  );
}

class UnknownStoredFormatError extends Error {}

export class LocalStorageConversationRepository implements ConversationRepository {
  private readonly key: string;

  constructor(
    private readonly window: Window,
    scope: ConversationScope,
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

  private access<T>(action: string, operation: (storage: Storage) => T): T {
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
  const text = getString(fields, 'text');
  const role = fields.get('role');
  if (role === 'user') return { id, role, text };
  if (role !== 'assistant') throw new UnknownStoredFormatError('unknown role');
  const kind = fields.get('kind');
  if (kind === AssistantMessageKind.Proposal) {
    return {
      id,
      role,
      kind,
      text,
      plan: getString(fields, 'plan'),
      proposal: parseProposal(fields.get('proposal')),
    };
  }
  if (!isReplyKind(kind)) throw new UnknownStoredFormatError('unknown message kind');
  return { id, role, kind, text };
}

function parseProposal(value: unknown): ProposalSummary {
  const fields = getFields(value);
  const operation = fields.get('operation');
  const lineNumber = getPositiveInteger(fields, 'lineNumber');
  const lineText = getString(fields, 'lineText');
  switch (operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return { operation, lineNumber, lineText };
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      return {
        operation,
        lineNumber,
        lineText,
        lineCount: getPositiveInteger(fields, 'lineCount'),
      };
    default:
      throw new UnknownStoredFormatError('unknown operation');
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

function getPositiveInteger(fields: Map<string, unknown>, key: string): number {
  const value = fields.get(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new UnknownStoredFormatError(`${key} is not a positive integer`);
  }
  return value;
}
