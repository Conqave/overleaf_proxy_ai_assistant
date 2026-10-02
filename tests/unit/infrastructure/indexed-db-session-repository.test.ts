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

const STORED_EDIT = {
  path: 'main.tex',
  command: { operation: 'delete', target: { lineNumber: 1, lineText: 'x' }, lineCount: 1 },
  status: 'proposed',
};
const STORED_APPLIED = { line: 1, before: ['x', 'y'], after: ['y'], sequence: 0 };
const STORED_APPLIED_EDIT = { ...STORED_EDIT, status: 'applied', applied: STORED_APPLIED };

const messages: ConversationMessage[] = [
  { id: '1', role: 'user', text: 'add a table' },
  {
    id: '2',
    role: 'assistant',
    kind: 'proposal',
    edits: [
      {
        path: 'main.tex',
        command: createDocumentCommand({
          operation: 'insert_after',
          target: { lineNumber: 4, lineText: 'Numbers.' },
          content: '\\begin{table}\n\\end{table}',
          reason: 'Adds a table.',
        }),
        status: 'rejected',
      },
    ],
  },
  {
    id: '3',
    role: 'assistant',
    kind: 'proposal',
    edits: [
      {
        path: 'chapters/results.tex',
        command: createDocumentCommand({
          operation: 'delete',
          target: { lineNumber: 2, lineText: 'Old.' },
          lineCount: 2,
        }),
        status: 'applied',
        applied: { line: 2, before: ['Old.', 'Older.', 'Kept.'], after: ['Kept.'], sequence: 0 },
      },
      {
        path: 'main.tex',
        command: createDocumentCommand({
          operation: 'replace',
          target: { lineNumber: 1, lineText: 'Title.' },
          content: 'New title.',
        }),
        status: 'applied',
        applied: { line: 1, before: ['Title.'], after: ['New title.'], sequence: 1 },
      },
    ],
  },
  { id: '4', role: 'system', text: 'Compiling reports errors; fix the first error.' },
  { id: '5', role: 'assistant', kind: 'explanation', text: 'It **compiles**.' },
  {
    id: 's1',
    role: 'summary',
    text: '## Goal\nA tidy report.',
    files: { read: ['refs.bib'], edited: ['main.tex'] },
    coveredUntilId: '4',
    coveredTurns: 2,
    tokensBefore: 72_000,
    tokensAfter: 38_000,
    createdAt: '2026-10-01T12:00:00.000Z',
  },
  {
    id: 't1',
    role: 'tool',
    record: {
      tool: 'read_file',
      path: 'refs.bib',
      shown: { first: 2, last: 3 },
      totalLines: 9,
      lines: ['  title = {A},', '}'],
    },
  },
  {
    id: 't2',
    role: 'tool',
    record: {
      tool: 'search',
      query: 'fig:a',
      matches: [{ path: 'main.tex', lineNumber: 4, lineText: 'See \\ref{fig:a}.' }],
      truncated: true,
    },
  },
  {
    id: 't2b',
    role: 'tool',
    record: { tool: 'search', query: '\\cite{', path: 'chapters', matches: [], truncated: false },
  },
  {
    id: 't3',
    role: 'tool',
    record: {
      tool: 'compile',
      diagnostics: [
        { level: 'error', message: 'Undefined control sequence.', path: 'main.tex', lineNumber: 2 },
        { level: 'warning', message: 'Overfull box.', path: 'main.tex' },
        { level: 'typesetting', message: 'Font shape undefined.' },
      ],
    },
  },
  {
    id: 't4',
    role: 'tool',
    record: {
      tool: 'read_file',
      path: 'e.tex',
      shown: { first: 1, last: 0 },
      totalLines: 0,
      lines: [],
    },
  },
  {
    id: 't5',
    role: 'tool',
    record: {
      tool: 'delegate',
      task: 'Check every \\cite key against refs.bib',
      files: ['main.tex', 'refs.bib'],
      report: {
        outcome: 'finished',
        text: 'main.tex:4 \\cite{a}: missing',
        truncated: false,
        lookups: 2,
      },
    },
  },
  {
    id: 't6',
    role: 'tool',
    record: {
      tool: 'delegate',
      task: 'List the tables of chapter 2',
      files: [],
      report: { outcome: 'failed', problem: 'the subagent stopped', lookups: 0 },
    },
  },
  {
    id: '7',
    role: 'undo',
    proposalId: '3',
    undone: ['chapters/results.tex'],
    refused: [{ path: 'main.tex', problem: 'main.tex changed after Hans edited it.' }],
  },
  ...(['proposed', 'failed', 'discarded', 'undone'] as const).map(
    (status): ConversationMessage => ({
      id: `6-${status}`,
      role: 'assistant',
      kind: 'proposal',
      edits: [
        {
          path: 'main.tex',
          command: createDocumentCommand({
            operation: 'delete',
            target: { lineNumber: 1, lineText: 'Gone.' },
          }),
          status,
        },
      ],
    }),
  ),
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
        {
          id: 'a',
          title: 'Session a',
          createdAt: 10,
          updatedAt: 20,
          messageCount: messages.length,
        },
        {
          id: 'b',
          title: 'Session b',
          createdAt: 10,
          updatedAt: 30,
          messageCount: messages.length,
        },
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
        messageCount: messages.length,
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

  it.each<[string, Record<string, unknown>]>([
    ['without messages', { messages: undefined }],
    ['with a message of an unknown role', { messages: [{ id: 'm', role: 'robot', text: '' }] }],
    ['with a count that does not match its messages', { messageCount: 2 }],
    ['with an empty title', { title: '' }],
    ['with a negative timestamp', { createdAt: -1 }],
    ['with a fractional timestamp', { updatedAt: 1.5 }],
    ...(
      [
        ['of an unknown tool', { tool: 'list_files' }],
        [
          'whose read lines do not match its range',
          {
            tool: 'read_file',
            path: 'a.tex',
            shown: { first: 1, last: 3 },
            totalLines: 9,
            lines: ['x'],
          },
        ],
        [
          'read past the end of its file',
          {
            tool: 'read_file',
            path: 'a.tex',
            shown: { first: 9, last: 9 },
            totalLines: 3,
            lines: ['x'],
          },
        ],
        ['of a search without its query', { tool: 'search', matches: [], truncated: false }],
        [
          'of a search in a broken path',
          { tool: 'search', query: 'q', path: '/abs', matches: [], truncated: false },
        ],
        [
          'of a search match at line zero',
          {
            tool: 'search',
            query: 'q',
            matches: [{ path: 'a.tex', lineNumber: 0, lineText: '' }],
            truncated: false,
          },
        ],
        [
          'of a diagnostic of an unknown level',
          { tool: 'compile', diagnostics: [{ level: 'fatal', message: 'x' }] },
        ],
        [
          'of a delegation without its report',
          { tool: 'delegate', task: 'Check every key', files: [] },
        ],
        [
          'of a delegation with a broken task',
          {
            tool: 'delegate',
            task: 'short',
            files: [],
            report: { outcome: 'failed', problem: 'p', lookups: 0 },
          },
        ],
        [
          'of a delegation with an untrimmed task',
          {
            tool: 'delegate',
            task: ' Check every key ',
            files: [],
            report: { outcome: 'failed', problem: 'p', lookups: 0 },
          },
        ],
        [
          'of a delegation with a file outside the project',
          {
            tool: 'delegate',
            task: 'Check every key',
            files: ['../x.tex'],
            report: { outcome: 'failed', problem: 'p', lookups: 0 },
          },
        ],
        [
          'of a delegation of an unknown outcome',
          {
            tool: 'delegate',
            task: 'Check every key',
            files: [],
            report: { outcome: 'partial', lookups: 0 },
          },
        ],
        [
          'of a delegation without the truncation flag',
          {
            tool: 'delegate',
            task: 'Check every key',
            files: [],
            report: { outcome: 'finished', text: 'x', lookups: 1 },
          },
        ],
      ] as const
    ).map(([name, record]): [string, Record<string, unknown>] => [
      `with a tool record ${name}`,
      { messages: [{ id: 't', role: 'tool', record }] },
    ]),
    ...(
      [
        ['without its text', { text: '' }],
        ['with a broken date', { createdAt: 'soon' }],
        ['with fractional tokens', { tokensAfter: 0.5 }],
        ['without its file lists', { files: { read: [] } }],
        ['of a file outside the project', { files: { read: ['/x'], edited: [] } }],
      ] as const
    ).map(([name, change]): [string, Record<string, unknown>] => [
      `with a summary ${name}`,
      {
        messages: [
          {
            id: 's',
            role: 'summary',
            text: 'note',
            files: { read: [], edited: [] },
            coveredUntilId: 'u',
            coveredTurns: 1,
            tokensBefore: 2,
            tokensAfter: 1,
            createdAt: '2026-10-01T12:00:00.000Z',
            ...change,
          },
        ],
      },
    ]),
    ...(
      [
        ['without edits', []],
        ['with more edits than a change may have', Array.from({ length: 9 }, () => STORED_EDIT)],
        ['with an edit of an unknown status', [{ ...STORED_EDIT, status: 'pending' }]],
        ['with an applied edit that lost its lines', [{ ...STORED_EDIT, status: 'applied' }]],
        [
          'with a rejected edit that keeps applied lines',
          [{ ...STORED_EDIT, status: 'rejected', applied: STORED_APPLIED }],
        ],
        [
          'with applied lines that are empty',
          [{ ...STORED_EDIT, status: 'applied', applied: { ...STORED_APPLIED, after: [] } }],
        ],
        [
          'with applied lines at line zero',
          [{ ...STORED_EDIT, status: 'applied', applied: { ...STORED_APPLIED, line: 0 } }],
        ],
        [
          'with two applied edits of one sequence number',
          [STORED_APPLIED_EDIT, STORED_APPLIED_EDIT],
        ],
      ] as const
    ).map(([name, edits]): [string, Record<string, unknown>] => [
      `with a change ${name}`,
      { messages: [{ id: 'p', role: 'assistant', kind: 'proposal', edits }] },
    ]),
    [
      'with an undo notice of a file outside the project',
      { messages: [{ id: 'n', role: 'undo', proposalId: 'p', undone: ['/x'], refused: [] }] },
    ],
    [
      'with an undo refusal without its problem',
      {
        messages: [
          { id: 'n', role: 'undo', proposalId: 'p', undone: [], refused: [{ path: 'a.tex' }] },
        ],
      },
    ],
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
