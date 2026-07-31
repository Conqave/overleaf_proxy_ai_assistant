import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../../../src/domain/conversation';
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
    text: 'Adds a table.',
    plan: 'After results.',
    proposal: { operation: 'insert_after', lineNumber: 4, lineText: 'Numbers.' },
  },
];

let storage: Storage;
let repository: LocalStorageConversationRepository;

beforeEach(() => {
  const { window } = new JSDOM('', { url: 'http://overleaf.test/' });
  storage = window.localStorage;
  repository = new LocalStorageConversationRepository(window as unknown as Window, SCOPE);
});

describe('LocalStorageConversationRepository', () => {
  it('keeps one conversation per user and project', () => {
    repository.save(messages);
    const window = { localStorage: storage } as unknown as Window;
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
    ['legacy v1 shape', JSON.stringify([{ text: 'hi', cls: 'ola-user' }])],
    ['unknown kind', JSON.stringify([{ id: '1', role: 'assistant', kind: 'x', text: '' }])],
    [
      'proposal without its change',
      JSON.stringify([{ id: '1', role: 'assistant', kind: 'proposal', text: '', plan: '' }]),
    ],
    [
      'proposal at line zero',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          text: '',
          plan: '',
          proposal: { operation: 'delete', lineNumber: 0, lineText: '', lineCount: 1 },
        },
      ]),
    ],
    [
      'bad proposal',
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          kind: 'proposal',
          text: '',
          plan: '',
          proposal: { operation: 'x' },
        },
      ]),
    ],
  ])('reports %s as a persistence error', (_name, raw) => {
    storage.setItem(KEY, raw);
    expect(() => repository.load()).toThrow(PersistenceError);
  });

  it('reports unavailable storage', () => {
    const hardened = {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    const blocked = new LocalStorageConversationRepository(hardened as Window, SCOPE);
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
    const repository = new LocalStorageConversationRepository(broken as Window, SCOPE);
    expect(() => repository.load()).toThrow(defect);
  });
});
