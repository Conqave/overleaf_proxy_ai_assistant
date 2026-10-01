import type { ConversationMessage } from '../../domain/conversation';
import type { ConversationRepository } from '../../ports/conversation-repository';
import { PersistenceError } from '../../ports/errors';
import type { OverleafPageIdentity } from '../overleaf/overleaf-page';
import { parseStoredMessages, UnknownStoredFormatError } from './stored-conversation-format';

type StorageAction = 'read' | 'save' | 'clear';

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
      return parseStoredMessages(JSON.parse(raw));
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
