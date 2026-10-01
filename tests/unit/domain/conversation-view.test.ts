import { describe, expect, it } from 'vitest';
import type { CompactionSummaryMessage, ExchangeMessage } from '../../../src/domain/conversation';
import {
  countCoveredMessages,
  createCompactionSummaryMessage,
  createConversationSummary,
  summarizeView,
  viewConversation,
} from '../../../src/domain/conversation-view';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvalidCompactionSummaryError } from '../../../src/domain/errors';

const user = (id: string): ExchangeMessage => ({ id, role: 'user', text: id });
const answer = (id: string): ExchangeMessage => ({
  id,
  role: 'assistant',
  kind: 'explanation',
  text: id,
});
const read = (id: string, path: string): ExchangeMessage => ({
  id,
  role: 'tool',
  record: { tool: 'read_file', path, shown: { first: 1, last: 1 }, totalLines: 1, lines: ['x'] },
});
const proposal = (id: string, path: string, status: 'applied' | 'rejected'): ExchangeMessage => ({
  id,
  role: 'assistant',
  kind: 'proposal',
  path,
  command: createDocumentCommand({
    operation: 'delete',
    target: { lineNumber: 1, lineText: 'x' },
  }),
  status,
});

function summary(id: string, coveredUntilId: string, coveredTurns = 1): CompactionSummaryMessage {
  return createCompactionSummaryMessage({
    id,
    text: `summary ${id}`,
    files: { read: [], edited: [] },
    coveredUntilId,
    coveredTurns,
    tokensBefore: 10,
    tokensAfter: 5,
    createdAt: '2026-10-01T12:00:00.000Z',
  });
}

describe('viewConversation', () => {
  it('shows every message when nothing is summarised', () => {
    const messages = [user('u1'), answer('a1')];
    expect(viewConversation(messages)).toEqual({ summary: null, messages });
  });

  it('replaces the turns the latest summary covers by that summary', () => {
    const first = summary('s1', 'a1');
    const latest = summary('s2', 'a2', 2);
    const view = viewConversation([
      user('u1'),
      answer('a1'),
      first,
      user('u2'),
      answer('a2'),
      user('u3'),
      latest,
      answer('a3'),
    ]);
    expect(view.summary).toBe(latest);
    expect(view.messages.map(({ id }) => id)).toEqual(['u3', 'a3']);
  });

  it('shows the rest once the covered turns are no longer stored', () => {
    const view = viewConversation([user('u2'), summary('s1', 'a1'), answer('a2')]);
    expect(view.messages.map(({ id }) => id)).toEqual(['u2', 'a2']);
  });

  it('counts the stored messages the latest summary covers', () => {
    expect(countCoveredMessages([user('u1'), answer('a1'), summary('s', 'a1')])).toBe(2);
    expect(countCoveredMessages([user('u1')])).toBe(0);
  });
});

describe('createConversationSummary', () => {
  it('rolls the previous summary into the new one with the files read and edited', () => {
    const previous = createConversationSummary(null, ' first ', [
      user('u1'),
      read('t1', 'refs.bib'),
      proposal('p1', 'main.tex', 'applied'),
    ]);
    expect(previous).toEqual({
      text: 'first',
      files: { read: ['refs.bib'], edited: ['main.tex'] },
      coveredUntilId: 'p1',
      coveredTurns: 1,
    });
    const next = createConversationSummary(previous, 'second', [
      user('u2'),
      read('t2', 'refs.bib'),
      read('t3', 'ch.tex'),
      proposal('p2', 'ch.tex', 'rejected'),
      { id: 's', role: 'system', text: 'Fix the first error.' },
    ]);
    expect(next).toEqual({
      text: 'second',
      files: { read: ['refs.bib', 'ch.tex'], edited: ['main.tex'] },
      coveredUntilId: 's',
      coveredTurns: 3,
    });
  });

  it('rejects an empty summary and a summary of nothing', () => {
    expect(() => createConversationSummary(null, '  ', [user('u1')])).toThrow(
      InvalidCompactionSummaryError,
    );
    expect(() => createConversationSummary(null, 'text', [])).toThrow(
      InvalidCompactionSummaryError,
    );
  });
});

describe('summarizeView', () => {
  it('keeps the messages after the covered ones', () => {
    const view = { summary: null, messages: [user('u1'), answer('a1'), user('u2')] };
    const covered = createConversationSummary(null, 'done', [user('u1'), answer('a1')]);
    expect(summarizeView(view, covered)).toEqual({ summary: covered, messages: [user('u2')] });
  });

  it('refuses a summary of messages the view does not show', () => {
    const covered = createConversationSummary(null, 'done', [user('x')]);
    expect(() => summarizeView({ summary: null, messages: [user('u1')] }, covered)).toThrow(
      InvalidCompactionSummaryError,
    );
  });
});

describe('createCompactionSummaryMessage', () => {
  const valid = {
    id: 's',
    text: 'note',
    files: { read: ['a.tex'], edited: [] },
    coveredUntilId: 'u1',
    coveredTurns: 1,
    tokensBefore: 10,
    tokensAfter: 4,
    createdAt: '2026-10-01T12:00:00.000Z',
  };

  it('creates a frozen summary message', () => {
    const message = createCompactionSummaryMessage(valid);
    expect(message).toEqual({ ...valid, role: 'summary' });
    expect(Object.isFrozen(message)).toBe(true);
  });

  it.each([
    ['an empty text', { text: ' ' }],
    ['no covered message', { coveredUntilId: '' }],
    ['a fractional token count', { tokensBefore: 1.5 }],
    ['negative turns', { coveredTurns: -1 }],
    ['a date that is none', { createdAt: 'yesterday' }],
    ['a file outside the project', { files: { read: ['../x.tex'], edited: [] } }],
  ])('rejects %s', (_name, change) => {
    expect(() => createCompactionSummaryMessage({ ...valid, ...change })).toThrow(
      InvalidCompactionSummaryError,
    );
  });
});
