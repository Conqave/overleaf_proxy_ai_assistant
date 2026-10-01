import {
  summarizeSession,
  type ConversationSession,
  type SessionSummary,
} from '../../domain/session';
import {
  SessionNotFoundError,
  SessionStorageError,
  UnreadableSessionError,
} from '../../ports/errors';
import type { SessionListing, SessionRepository } from '../../ports/session-repository';
import type { OverleafPageIdentity } from '../overleaf/overleaf-page';
import {
  parseStoredSession,
  toStoredSession,
  UnknownStoredFormatError,
} from './stored-conversation-format';

export const SESSION_DATABASE = 'overleaf-ai-assistant';
export const SESSION_STORE = 'sessions';
const DATABASE_VERSION = 1;
const SCOPE_INDEX = 'by-scope';
const KEY_PATH = ['userId', 'projectId', 'id'];
const SCOPE_KEY_PATH = ['userId', 'projectId'];

type StorageAction = 'open' | 'list' | 'load' | 'save' | 'delete';

const ACTION_TEXT: Record<StorageAction, string> = {
  open: 'open the saved sessions of this browser',
  list: 'list the saved sessions',
  load: 'load the saved session',
  save: 'save the session',
  delete: 'delete the saved session',
};

interface StoredEntry {
  readonly primaryKey: IDBValidKey;
  readonly value: unknown;
}

export class IndexedDbSessionRepository implements SessionRepository {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly window: { readonly indexedDB: Pick<IDBFactory, 'open'> },
    private readonly scope: OverleafPageIdentity,
  ) {}

  async list(): Promise<SessionListing> {
    const database = await this.open();
    const request = access('list', () =>
      database
        .transaction(SESSION_STORE, 'readonly')
        .objectStore(SESSION_STORE)
        .index(SCOPE_INDEX)
        .openCursor([this.scope.userId, this.scope.projectId]),
    );
    const sessions: SessionSummary[] = [];
    const unreadableIds: string[] = [];
    for (const entry of await collect(request)) {
      const id = sessionIdOf(entry.primaryKey);
      let session: ConversationSession;
      try {
        session = this.parse(entry.value);
      } catch (error) {
        if (!(error instanceof UnreadableSessionError)) throw error;
        unreadableIds.push(id);
        continue;
      }
      sessions.push(summarizeSession(session));
    }
    return { sessions, unreadableIds };
  }

  async load(id: string): Promise<ConversationSession> {
    const database = await this.open();
    const request: IDBRequest<unknown> = access('load', () =>
      database
        .transaction(SESSION_STORE, 'readonly')
        .objectStore(SESSION_STORE)
        .get(this.keyOf(id)),
    );
    const value = await succeeded(request, 'load');
    if (value === undefined) {
      throw new SessionNotFoundError(
        'This session no longer exists; another tab may have deleted it.',
      );
    }
    return this.parse(value);
  }

  async save(session: ConversationSession): Promise<void> {
    const database = await this.open();
    const transaction = access('save', () => {
      const writing = database.transaction(SESSION_STORE, 'readwrite');
      writing.objectStore(SESSION_STORE).put(toStoredSession(session, this.scope));
      return writing;
    });
    await committed(transaction, 'save');
  }

  async delete(id: string): Promise<void> {
    const database = await this.open();
    const transaction = access('delete', () => {
      const writing = database.transaction(SESSION_STORE, 'readwrite');
      writing.objectStore(SESSION_STORE).delete(this.keyOf(id));
      return writing;
    });
    await committed(transaction, 'delete');
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= this.openDatabase();
    return this.database;
  }

  private async openDatabase(): Promise<IDBDatabase> {
    const request = access('open', () =>
      this.window.indexedDB.open(SESSION_DATABASE, DATABASE_VERSION),
    );
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(SESSION_STORE, { keyPath: KEY_PATH });
      store.createIndex(SCOPE_INDEX, SCOPE_KEY_PATH);
    };
    return await succeeded(request, 'open');
  }

  private keyOf(id: string): IDBValidKey {
    return [this.scope.userId, this.scope.projectId, id];
  }

  private parse(value: unknown): ConversationSession {
    try {
      return parseStoredSession(value, this.scope);
    } catch (error) {
      if (!(error instanceof UnknownStoredFormatError)) throw error;
      throw new UnreadableSessionError(
        'A saved session has an unknown format and was not loaded.',
        { cause: error },
      );
    }
  }
}

function sessionIdOf(primaryKey: IDBValidKey): string {
  if (!Array.isArray(primaryKey)) throw unreadableKey();
  const id: unknown = primaryKey[KEY_PATH.length - 1];
  if (typeof id !== 'string') throw unreadableKey();
  return id;
}

function unreadableKey(): UnreadableSessionError {
  return new UnreadableSessionError('The saved sessions have an unknown key format.');
}

function access<T>(action: StorageAction, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    throw storageError(action, error);
  }
}

function storageError(action: StorageAction, cause: DOMException | null): SessionStorageError {
  return new SessionStorageError(`Could not ${ACTION_TEXT[action]}.`, { cause });
}

function succeeded<T>(request: IDBRequest<T>, action: StorageAction): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(storageError(action, request.error));
    };
  });
}

function committed(transaction: IDBTransaction, action: StorageAction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(storageError(action, transaction.error));
    };
  });
}

function collect(request: IDBRequest<IDBCursorWithValue | null>): Promise<StoredEntry[]> {
  const entries: StoredEntry[] = [];
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve(entries);
        return;
      }
      entries.push({ primaryKey: cursor.primaryKey, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => {
      reject(storageError('list', request.error));
    };
  });
}
