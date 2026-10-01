import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../../../src/domain/conversation';
import { createDocumentCommand } from '../../../src/domain/document-command';
import type { ConversationSession } from '../../../src/domain/session';
import {
  IndexedDbSessionRepository,
  SESSION_DATABASE,
} from '../../../src/infrastructure/persistence/indexed-db-session-repository';
import {
  SessionNotFoundError,
  SessionStorageError,
  UnreadableSessionError,
} from '../../../src/ports/errors';
import { itemAt } from '../../support/guards';
import { readStoredSessions, settled, storeRawSession } from '../../support/session-store';

const SCOPE = { userId: 'user-1', projectId: 'project-1' };

const messages: ConversationMessage[] = [
  { id: '1', role: 'user', text: 'add a table' },
  {
    id: '2',
    role: 'assistant',
    kind: 'proposal',
    path: 'main.tex',
    command: createDocumentCommand({
      operation: 'insert_after',
      target: { lineNumber: 4, lineText: 'Numbers.' },
      content: '\\begin{table}\n\\end{table}',
      reason: 'Adds a table.',
    }),
    status: 'rejected',
  },
  {
    id: '3',
    role: 'assistant',
    kind: 'proposal',
    path: 'chapters/results.tex',
    command: createDocumentCommand({
      operation: 'delete',
      target: { lineNumber: 2, lineText: 'Old.' },
      lineCount: 2,
    }),
    status: 'applied',
  },
  { id: '4', role: 'system', text: 'Compiling reports errors; fix the first error.' },
  { id: '5', role: 'assistant', kind: 'explanation', text: 'It **compiles**.' },
  ...(['proposed', 'failed', 'discarded'] as const).map((status): ConversationMessage => ({
    id: `6-${status}`,
    role: 'assistant',
    kind: 'proposal',
    path: 'main.tex',
    command: createDocumentCommand({
      operation: 'delete',
      target: { lineNumber: 1, lineText: 'Gone.' },
    }),
    status,
  })),
];

function session(id: string, updatedAt = 20): ConversationSession {
  return { id, title: `Session ${id}`, createdAt: 10, updatedAt, messages };
}

let factory: IDBFactory;
let repository: IndexedDbSessionRepository;

async function storedRecords(): Promise<unknown[]> {
  return await readStoredSessions(factory);
}

async function storeRaw(record: Record<string, unknown>): Promise<void> {
  await repository.list();
  await storeRawSession(factory, record);
}

function rawRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ...SCOPE,
    id: 'raw',
    title: 'Raw',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    messages: [{ id: 'u', role: 'user', text: 'hi' }],
    ...overrides,
  };
}

beforeEach(() => {
  factory = new IDBFactory();
  repository = new IndexedDbSessionRepository({ indexedDB: factory }, SCOPE);
});

describe('IndexedDbSessionRepository', () => {
  it('saves, lists, loads and deletes sessions', async () => {
    await expect(repository.list()).resolves.toEqual({ sessions: [], unreadableIds: [] });
    await repository.save(session('a'));
    await repository.save(session('b', 30));
    await expect(repository.load('a')).resolves.toEqual(session('a'));
    await expect(repository.list()).resolves.toEqual({
      sessions: [
        { id: 'a', title: 'Session a', createdAt: 10, updatedAt: 20, messageCount: 8 },
        { id: 'b', title: 'Session b', createdAt: 10, updatedAt: 30, messageCount: 8 },
      ],
      unreadableIds: [],
    });
    await repository.delete('a');
    await expect(repository.load('a')).rejects.toThrow(SessionNotFoundError);
    await expect(repository.list()).resolves.toMatchObject({ sessions: [{ id: 'b' }] });
  });

  it('stores one record per session with its scope, summary and messages', async () => {
    await repository.save(session('a'));
    expect(await storedRecords()).toEqual([
      {
        ...SCOPE,
        id: 'a',
        title: 'Session a',
        createdAt: 10,
        updatedAt: 20,
        messageCount: 8,
        messages,
      },
    ]);
  });

  it('replaces a session saved again', async () => {
    await repository.save(session('a'));
    const continued = { ...session('a', 40), messages: messages.slice(0, 1) };
    await repository.save(continued);
    await expect(repository.load('a')).resolves.toEqual(continued);
    expect(await storedRecords()).toHaveLength(1);
  });

  it('keeps the sessions of other projects and users apart', async () => {
    const otherProject = new IndexedDbSessionRepository(
      { indexedDB: factory },
      { ...SCOPE, projectId: 'p-2' },
    );
    const otherUser = new IndexedDbSessionRepository(
      { indexedDB: factory },
      { ...SCOPE, userId: 'u-2' },
    );
    await repository.save(session('a'));
    await otherProject.save({ ...session('a'), title: 'Other project' });
    await expect(otherUser.list()).resolves.toEqual({ sessions: [], unreadableIds: [] });
    await expect(otherUser.load('a')).rejects.toThrow(SessionNotFoundError);
    await otherUser.delete('a');
    await expect(otherProject.list()).resolves.toMatchObject({
      sessions: [{ id: 'a', title: 'Other project' }],
    });
    await expect(repository.load('a')).resolves.toEqual(session('a'));
  });

  it('applies operations in the order they were called', async () => {
    const saving = repository.save(session('a'));
    const listing = repository.list();
    const deleting = repository.delete('a');
    const loading = repository.load('a');
    await saving;
    await deleting;
    await expect(listing).resolves.toMatchObject({ sessions: [{ id: 'a' }] });
    await expect(loading).rejects.toThrow(SessionNotFoundError);
  });

  it.each([
    ['without messages', { messages: undefined }],
    ['with a message of an unknown role', { messages: [{ id: 'm', role: 'robot', text: '' }] }],
    ['with a count that does not match its messages', { messageCount: 2 }],
    ['with an empty title', { title: '' }],
    ['with a negative timestamp', { createdAt: -1 }],
    ['with a fractional timestamp', { updatedAt: 1.5 }],
  ])('lists a session %s as unreadable and does not load it', async (_name, overrides) => {
    await repository.save(session('a'));
    await storeRaw(rawRecord(overrides));
    await expect(repository.list()).resolves.toEqual({
      sessions: [expect.objectContaining({ id: 'a' })],
      unreadableIds: ['raw'],
    });
    await expect(repository.load('raw')).rejects.toThrow(UnreadableSessionError);
    await expect(repository.load('raw')).rejects.toMatchObject({
      cause: { name: 'UnknownStoredFormatError' },
    });
  });

  it('loads a valid raw record without the fields it does not know', async () => {
    await storeRaw(rawRecord({ extra: true }));
    await expect(repository.load('raw')).resolves.toEqual({
      id: 'raw',
      title: 'Raw',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: 'u', role: 'user', text: 'hi' }],
    });
  });

  it('reports a database it cannot open', async () => {
    await settled(factory.open(SESSION_DATABASE, 2));
    await expect(repository.list()).rejects.toThrow(SessionStorageError);
    await expect(repository.list()).rejects.toMatchObject({
      message: 'Could not open the saved sessions of this browser.',
      cause: { name: 'VersionError' },
    });
  });

  it('reports storage the browser denies for every operation', async () => {
    const denied = {
      indexedDB: {
        open(): IDBOpenDBRequest {
          throw new DOMException('denied', 'SecurityError');
        },
      },
    };
    const blocked = new IndexedDbSessionRepository(denied, SCOPE);
    await expect(blocked.list()).rejects.toThrow(SessionStorageError);
    await expect(blocked.save(session('a'))).rejects.toThrow(SessionStorageError);
    await expect(blocked.delete('a')).rejects.toThrow(SessionStorageError);
  });

  it('reports a session the browser cannot store', async () => {
    const withFunction = Object.assign({ render: () => 'x' }, itemAt(messages, 0, 'message'));
    await expect(
      repository.save({ ...session('a'), messages: [withFunction] }),
    ).rejects.toMatchObject({ name: 'SessionStorageError', cause: { name: 'DataCloneError' } });
  });

  it('lets defects through unchanged', async () => {
    const defect = new TypeError('bug');
    const broken = {
      get indexedDB(): IDBFactory {
        throw defect;
      },
    };
    await expect(new IndexedDbSessionRepository(broken, SCOPE).list()).rejects.toBe(defect);
  });
});
