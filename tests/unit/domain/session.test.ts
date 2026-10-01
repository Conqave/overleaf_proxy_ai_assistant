import { describe, expect, it } from 'vitest';
import type { ConversationMessage, UserMessage } from '../../../src/domain/conversation';
import { InvariantViolation } from '../../../src/domain/errors';
import {
  appendToSession,
  createSessionTitle,
  MAX_SESSION_MESSAGES,
  MAX_SESSION_TITLE_LENGTH,
  replaceInSession,
  sortNewestFirst,
  startSession,
  summarizeSession,
  type SessionSummary,
} from '../../../src/domain/session';

const first: UserMessage = { id: 'u1', role: 'user', text: '  Add a table\n of results  ' };
const answer: ConversationMessage = {
  id: 'a1',
  role: 'assistant',
  kind: 'explanation',
  text: 'Done.',
};

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

  it('keeps only the newest messages and its title', () => {
    let session = startSession('s1', first, 1);
    for (let index = 0; index < MAX_SESSION_MESSAGES; index += 1) {
      session = appendToSession(session, { ...answer, id: `a${String(index)}` }, 2);
    }
    expect(session.messages).toHaveLength(MAX_SESSION_MESSAGES);
    expect(session.messages[0]?.id).toBe('a0');
    expect(session.title).toBe('Add a table of results');
  });

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
