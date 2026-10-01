import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../../../src/domain/conversation';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { LocalStorageConversationRepository } from '../../../src/infrastructure/persistence/local-storage-conversation-repository';
import { PersistenceError } from '../../../src/ports/errors';

const SCOPE = { userId: 'user-1', projectId: 'project-1' };
const KEY = 'ola-conversation:user-1:project-1';
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
  ...(['proposed', 'failed', 'discarded'] as const).map((status): ConversationMessage => ({
    id: `5-${status}`,
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

let storage: Storage;
let repository: LocalStorageConversationRepository;

beforeEach(() => {
  const { window } = new JSDOM('', { url: 'http://overleaf.test/' });
  storage = window.localStorage;
  repository = new LocalStorageConversationRepository(window, SCOPE);
});

describe('LocalStorageConversationRepository', () => {
  it('keeps one conversation per user and project', () => {
    repository.save(messages);
    const window = { localStorage: storage };
    const otherProject = new LocalStorageConversationRepository(window, {
      ...SCOPE,
      projectId: 'project-2',
    });
    const otherUser = new LocalStorageConversationRepository(window, {
      ...SCOPE,
      userId: 'user-2',
    });
    expect(otherProject.load()).toEqual([]);
    expect(otherUser.load()).toEqual([]);
    expect(repository.load()).toEqual(messages);
  });

  it('loads fresh messages without fields it does not know', () => {
    storage.setItem(KEY, JSON.stringify([{ id: '1', role: 'user', text: 'hi', extra: true }]));
    expect(repository.load()).toEqual([{ id: '1', role: 'user', text: 'hi' }]);
  });

  it('round-trips messages', () => {
    expect(repository.load()).toEqual([]);
    repository.save(messages);
    expect(repository.load()).toEqual(messages);
    repository.clear();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it.each([
    ['invalid JSON', '[{'],
    ['not an array', '{}'],
    ['message without id and role', JSON.stringify([{ text: 'hi', cls: 'ola-user' }])],
    ['unknown kind', JSON.stringify([{ id: '1', role: 'assistant', kind: 'x', text: '' }])],
    [
      'proposal without its command',
      JSON.stringify([{ id: '1', role: 'assistant', kind: 'proposal' }]),
    ],
    [
      'proposal without its file path',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          command: { operation: 'delete', target: { lineNumber: 1, lineText: '' }, lineCount: 1 },
        },
      ]),
    ],
    [
      'proposal with a path outside the project',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          path: '../main.tex',
          command: { operation: 'delete', target: { lineNumber: 1, lineText: '' }, lineCount: 1 },
        },
      ]),
    ],
    [
      'proposal at line zero',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          path: 'main.tex',
          command: { operation: 'delete', target: { lineNumber: 0, lineText: '' }, lineCount: 1 },
        },
      ]),
    ],
    [
      'proposal without its decision status',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          path: 'main.tex',
          command: { operation: 'delete', target: { lineNumber: 1, lineText: 'x' }, lineCount: 1 },
        },
      ]),
    ],
    [
      'proposal with an unknown decision status',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          path: 'main.tex',
          command: { operation: 'delete', target: { lineNumber: 1, lineText: 'x' }, lineCount: 1 },
          status: 'maybe',
        },
      ]),
    ],
    [
      'unknown operation',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          path: 'main.tex',
          command: { operation: 'x' },
        },
      ]),
    ],
  ])('reports %s as a persistence error', (_name, raw) => {
    storage.setItem(KEY, raw);
    expect(() => repository.load()).toThrow(PersistenceError);
  });

  it('keeps the named format problem as the cause', () => {
    storage.setItem(KEY, '{}');
    const failure = (() => {
      try {
        repository.load();
      } catch (error) {
        if (!(error instanceof PersistenceError)) throw error;
        return error;
      }
    })();
    expect(failure?.cause).toMatchObject({
      name: 'UnknownStoredFormatError',
      message: 'not an array',
    });
  });

  it('reports unavailable storage', () => {
    const hardened = {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    const blocked = new LocalStorageConversationRepository(hardened, SCOPE);
    expect(() => blocked.load()).toThrow(PersistenceError);
    expect(() => {
      blocked.save(messages);
    }).toThrow(PersistenceError);
  });

  it('lets defects through unchanged', () => {
    const defect = new TypeError('bug');
    const broken = {
      get localStorage(): Storage {
        throw defect;
      },
    };
    const repository = new LocalStorageConversationRepository(broken, SCOPE);
    expect(() => repository.load()).toThrow(defect);
  });
});
