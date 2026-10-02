import { describe, expect, it } from 'vitest';
import type {
  CompactionSummaryMessage,
  ConversationMessage,
  UserMessage,
} from '../../../src/domain/conversation';
import { EditStatus } from '../../../src/domain/change-set';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import {
  appendToSession,
  createSessionTitle,
  discardUndecidedProposals,
  hasUndecidedProposals,
  MAX_SESSION_MESSAGES,
  MAX_SESSION_TITLE_LENGTH,
  replaceInSession,
  sortNewestFirst,
  startSession,
  summarizeSession,
  type SessionSummary,
} from '../../../src/domain/session';
import { editWith, proposalOf } from '../../support/proposals';

const first: UserMessage = { id: 'u1', role: 'user', text: '  Add a table\n of results  ' };
const answer: ConversationMessage = {
  id: 'a1',
  role: 'assistant',
  kind: 'explanation',
  text: 'Done.',
};

function summaryUntil(coveredUntilId: string): CompactionSummaryMessage {
  return {
    id: 'summary',
    role: 'summary',
    text: 'Earlier turns.',
    files: { read: [], edited: [] },
    coveredUntilId,
    coveredTurns: 1,
    tokensBefore: 2,
    tokensAfter: 1,
    createdAt: '2026-10-01T12:00:00.000Z',
  };
}

function summary(id: string, createdAt: number, updatedAt: number): SessionSummary {
  return { id, title: id, createdAt, updatedAt, messageCount: 1 };
}

describe('session title', () => {
  it('is the first request on one trimmed line', () => {
    expect(createSessionTitle(first.text)).toBe('Add a table of results');
  });

  it('is shortened with an ellipsis when the request is long', () => {
    const title = createSessionTitle(`${'word '.repeat(40)}end`);
    expect(title).toHaveLength(MAX_SESSION_TITLE_LENGTH);
    expect(title.endsWith('word…')).toBe(true);
  });

  it('keeps a request of exactly the maximum length whole', () => {
    const request = 'x'.repeat(MAX_SESSION_TITLE_LENGTH);
    expect(createSessionTitle(request)).toBe(request);
  });

  it('cannot come from a blank request', () => {
    expect(() => createSessionTitle(' \n ')).toThrow(InvariantViolation);
  });
});

describe('session', () => {
  it('starts with its first request and records when it changed', () => {
    const started = startSession('s1', first, 100);
    expect(started).toEqual({
      id: 's1',
      title: 'Add a table of results',
      createdAt: 100,
      updatedAt: 100,
      messages: [first],
    });
    const continued = appendToSession(started, answer, 250);
    expect(continued.messages).toEqual([first, answer]);
    expect(continued.createdAt).toBe(100);
    expect(continued.updatedAt).toBe(250);
    expect(summarizeSession(continued)).toEqual({
      id: 's1',
      title: 'Add a table of results',
      createdAt: 100,
      updatedAt: 250,
      messageCount: 2,
    });
  });

  it('keeps every message while no summary covers them', () => {
    let session = startSession('s1', first, 1);
    for (let index = 0; index < MAX_SESSION_MESSAGES; index += 1) {
      session = appendToSession(session, { ...answer, id: `a${String(index)}` }, 2);
    }
    expect(session.messages).toHaveLength(MAX_SESSION_MESSAGES + 1);
    expect(session.messages[0]).toBe(first);
    expect(session.title).toBe('Add a table of results');
  });

  it.each([
    [30, MAX_SESSION_MESSAGES, 'm7'],
    [3, 84, 'm3'],
  ])(
    'drops beyond the limit only messages a summary covers, when %i are covered',
    (covered, kept, firstKept) => {
      const messages = Array.from({ length: 85 }, (_, index): ConversationMessage => ({
        id: `m${String(index)}`,
        role: 'user',
        text: 'hi',
      }));
      const session = {
        ...startSession('s1', first, 1),
        messages: [...messages, summaryUntil(`m${String(covered - 1)}`)],
      };
      const appended = appendToSession(session, { ...answer, id: 'next' }, 2);
      expect(appended.messages).toHaveLength(kept);
      expect(appended.messages[0]?.id).toBe(firstKept);
      expect(appended.messages.at(-2)?.role).toBe('summary');
    },
  );

  it('replaces a message it holds and refuses one it does not', () => {
    const session = appendToSession(startSession('s1', first, 1), answer, 2);
    const edited = { ...answer, text: 'Changed.' };
    expect(replaceInSession(session, edited, 3)).toMatchObject({
      updatedAt: 3,
      messages: [first, edited],
    });
    expect(() => replaceInSession(session, { ...answer, id: 'other' }, 3)).toThrow(
      InvariantViolation,
    );
  });

  it('lists the most recently changed sessions first', () => {
    const sessions = [summary('a', 1, 5), summary('b', 2, 9), summary('c', 3, 5)];
    expect(sortNewestFirst(sessions).map(({ id }) => id)).toEqual(['b', 'c', 'a']);
    expect(sessions.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });
});

describe('undecided proposals', () => {
  const command = createDocumentCommand({
    operation: 'delete',
    target: { lineNumber: 2, lineText: 'x' },
  });
  const decided = proposalOf('p1', editWith('a.tex', command, EditStatus.Applied));
  const undecided = proposalOf(
    'p2',
    editWith('a.tex', command, EditStatus.Rejected),
    editWith('b.tex', command, EditStatus.Proposed),
  );
  const session = { ...startSession('s1', first, 1), messages: [first, decided, undecided] };

  it('are discarded while decided edits keep their status', () => {
    expect(hasUndecidedProposals(session)).toBe(true);
    const discarded = discardUndecidedProposals(session);
    expect(discarded.messages).toEqual([
      first,
      decided,
      proposalOf(
        'p2',
        editWith('a.tex', command, EditStatus.Rejected),
        editWith('b.tex', command, EditStatus.Discarded),
      ),
    ]);
    expect(hasUndecidedProposals(discarded)).toBe(false);
  });
});
