import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChangeNoLongerPendingError,
  RequestInProgressError,
  RequestSupersededError,
} from '../../../src/application/errors';
import { COMPILE_FIX_REQUEST } from '../../../src/application/conversation-agent';
import { answer } from '../../support/decisions';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import {
  SessionNotFoundError,
  SessionStorageError,
  UnreadableSessionError,
} from '../../../src/ports/errors';
import { PendingStep, rejectOnAbort, storedSession } from '../../support/fakes';
import { itemAt } from '../../support/guards';
import { TestFixtureError } from '../../support/test-errors';
import { UseCaseWorld, MAIN } from '../../support/use-case-world';

let world: UseCaseWorld;

beforeEach(() => {
  world = new UseCaseWorld();
});

describe('conversation', () => {
  it('restores the latest session and starts a new one without deleting it', async () => {
    world.seed(storedSession('old', [{ id: 'a', role: 'user', text: 'older' }], 1));
    world.seed(storedSession('latest', [{ id: 'b', role: 'user', text: 'latest' }], 2));
    await world.restore();
    expect(world.conversation.messages()).toEqual([{ id: 'b', role: 'user', text: 'latest' }]);
    expect(world.conversation.sessionId).toBe('latest');
    const changeId = await world.proposeEdit();
    await world.startNew();
    expect(world.conversation.messages()).toHaveLength(0);
    expect(world.conversation.sessionId).toBeNull();
    expect(world.repository.stored.get('latest')?.messages.at(-1)).toMatchObject({
      id: changeId,
      edits: [{ status: 'discarded' }],
    });
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
    world.agent.will(answer('Fresh.'));
    await world.send('fresh start');
    expect(world.conversation.sessionId).toBe('session-1');
    expect(world.repository.stored.get('session-1')).toMatchObject({
      title: 'fresh start',
      messages: [{ role: 'user', text: 'fresh start' }, { text: 'Fresh.' }],
    });
    expect(world.repository.stored.size).toBe(3);
  });

  it('starts with a new session when none is stored', async () => {
    await world.restore();
    expect(world.conversation.messages()).toEqual([]);
    expect(world.conversation.sessionId).toBeNull();
    expect(world.repository.stored.size).toBe(0);
  });

  it('restores while holding the operation lock', async () => {
    const restoring = world.restore();
    expect(world.isBusy()).toBe(true);
    await expect(world.send('too early')).rejects.toThrow(RequestInProgressError);
    await restoring;
    expect(world.isBusy()).toBe(false);
  });

  it('discards the proposals a reload left undecided', async () => {
    const deleteFirst = {
      path: 'main.tex',
      command: createDocumentCommand({
        operation: 'delete',
        target: { lineNumber: 1, lineText: itemAt(MAIN, 0, 'line') },
      }),
    };
    const undecided = {
      id: 'p',
      role: 'assistant' as const,
      kind: 'proposal' as const,
      edits: [{ ...deleteFirst, status: 'proposed' as const }],
    };
    world.seed(storedSession('s', [{ id: 'u', role: 'user', text: 'delete it' }, undecided]));
    const discarded = { ...undecided, edits: [{ ...deleteFirst, status: 'discarded' }] };
    await world.restore();
    expect(world.conversation.messages()).toEqual([
      { id: 'u', role: 'user', text: 'delete it' },
      discarded,
    ]);
    expect(world.storedMessages().at(-1)).toEqual(discarded);
    expect(world.repository.only().updatedAt).toBe(1);
  });

  it('records when a session started and last changed', async () => {
    world.agent.will(answer('One.'), answer('Two.'));
    await world.send('  first\n request ');
    await world.send('second');
    expect(world.repository.only()).toMatchObject({
      id: 'session-1',
      title: 'first request',
      createdAt: 1,
      updatedAt: 4,
    });
  });

  it('keeps working when storage fails and reports it once', async () => {
    world.repository.failing = true;
    world.agent.will(answer('Hi.'));
    const result = await world.send('hello');
    expect(result.message.kind).toBe('explanation');
    expect(world.conversation.messages()).toHaveLength(2);
    expect((await world.conversation.takePersistenceFailure())?.message).toBe('storage off');
    await expect(world.conversation.takePersistenceFailure()).resolves.toBeNull();
  });

  it('reports storage that cannot list the sessions', async () => {
    world.repository.failing = true;
    await expect(world.restore()).rejects.toThrow(SessionStorageError);
    expect(world.isBusy()).toBe(false);
  });

  it('starts a session only with a request of the user', () => {
    expect(() => {
      world.conversation.append({ id: 's', role: 'system', text: COMPILE_FIX_REQUEST });
    }).toThrow(InvariantViolation);
  });

  it('keeps every message no summary covers', async () => {
    for (let i = 0; i < 45; i += 1) {
      world.agent.will(answer('Hi.'));
      await world.send('hi');
    }
    expect(world.storedMessages()).toHaveLength(90);
  });
});

describe('sessions', () => {
  const older = storedSession('older', [{ id: 'o', role: 'user', text: 'older' }], 1);
  const deleteFirst = {
    path: 'main.tex',
    command: createDocumentCommand({
      operation: 'delete',
      target: { lineNumber: 1, lineText: itemAt(MAIN, 0, 'line') },
    }),
  };
  const proposalOf = (id: string, status: 'proposed' | 'applied') => ({
    id,
    role: 'assistant' as const,
    kind: 'proposal' as const,
    edits: [
      status === 'proposed'
        ? { ...deleteFirst, status }
        : {
            ...deleteFirst,
            status,
            applied: { line: 1, before: MAIN.slice(0, 2), after: MAIN.slice(1, 2), sequence: 0 },
          },
    ],
  });
  const decided = storedSession(
    'decided',
    [{ id: 'd', role: 'user', text: 'delete it' }, proposalOf('applied', 'applied')],
    5,
  );

  beforeEach(() => {
    world.seed(older);
    world.seed(decided);
  });

  it('lists the sessions newest first with the current and the unreadable ones', async () => {
    world.repository.unreadableIds = ['broken'];
    await world.openSession('older');
    await expect(world.listSessions()).resolves.toEqual({
      sessions: [
        {
          id: 'decided',
          title: 'Session decided',
          createdAt: 0,
          updatedAt: 5,
          chatMessageCount: 2,
        },
        { id: 'older', title: 'Session older', createdAt: 0, updatedAt: 1, chatMessageCount: 1 },
      ],
      unreadableIds: ['broken'],
      currentId: 'older',
    });
  });

  it('opens a session with its decisions and continues it', async () => {
    await world.openSession('decided');
    expect(world.conversation.sessionId).toBe('decided');
    expect(world.conversation.messages()).toEqual(decided.messages);
    world.agent.will(answer('Done before.'));
    await world.send('was it applied?');
    expect(world.repository.stored.get('decided')).toMatchObject({
      title: 'Session decided',
      messages: [
        { id: 'd' },
        { id: 'applied' },
        { text: 'was it applied?' },
        { kind: 'explanation' },
      ],
    });
    expect(world.repository.stored.get('older')).toEqual(older);
  });

  it('discards the proposals left undecided in the opened session', async () => {
    world.seed(
      storedSession('open', [{ id: 'u', role: 'user', text: 'x' }, proposalOf('p', 'proposed')]),
    );
    await world.openSession('open');
    expect(world.conversation.messages().at(-1)).toMatchObject({
      id: 'p',
      edits: [{ status: 'discarded' }],
    });
    expect(world.repository.stored.get('open')?.messages.at(-1)).toMatchObject({
      edits: [{ status: 'discarded' }],
    });
  });

  it('discards the pending change of the session it leaves', async () => {
    const changeId = await world.proposeEdit();
    const left = world.conversation.sessionId;
    if (left === null) throw new TestFixtureError('the request started no session');
    await world.openSession('older');
    expect(world.editor.preview).toBeNull();
    expect(world.conversation.messages()).toEqual(older.messages);
    expect(world.repository.stored.get(left)?.messages.at(-1)).toMatchObject({
      id: changeId,
      edits: [{ status: 'discarded' }],
    });
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
  });

  it('keeps the current session when the opened one cannot be loaded', async () => {
    await world.openSession('older');
    world.repository.unreadableIds = ['decided'];
    await expect(world.openSession('decided')).rejects.toThrow(UnreadableSessionError);
    await expect(world.openSession('gone')).rejects.toThrow(SessionNotFoundError);
    expect(world.conversation.sessionId).toBe('older');
    expect(world.isBusy()).toBe(false);
  });

  it('refuses to open or delete a session while an operation runs', async () => {
    world.agent.will(new PendingStep(rejectOnAbort));
    const running = world.send('summarize');
    await vi.waitFor(() => {
      expect(world.agent.requests).toHaveLength(1);
    });
    const current = world.conversation.sessionId;
    await expect(world.openSession('older')).rejects.toThrow(RequestInProgressError);
    await expect(world.deleteSession('older')).rejects.toThrow(RequestInProgressError);
    expect(world.conversation.sessionId).toBe(current);
    expect(world.repository.stored.has('older')).toBe(true);
    const reset = world.startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
    await reset;
  });

  it('holds the operation lock while it opens a session', async () => {
    const loaded = Promise.withResolvers<undefined>();
    world.repository.loadsHeldUntil = loaded.promise;
    const opening = world.openSession('older');
    expect(world.isBusy()).toBe(true);
    await expect(world.send('too early')).rejects.toThrow(RequestInProgressError);
    loaded.resolve(undefined);
    await opening;
    expect(world.conversation.sessionId).toBe('older');
  });

  it('drops a session that finishes loading after a new conversation started', async () => {
    const loaded = Promise.withResolvers<undefined>();
    world.repository.loadsHeldUntil = loaded.promise;
    const opening = world.openSession('older');
    const reset = world.startNew();
    loaded.resolve(undefined);
    await expect(opening).rejects.toThrow(RequestSupersededError);
    await reset;
    expect(world.conversation.sessionId).toBeNull();
    expect(world.conversation.messages()).toEqual([]);
  });

  it('deletes another session and keeps the current one', async () => {
    await world.openSession('decided');
    await world.deleteSession('older');
    expect(world.repository.stored.has('older')).toBe(false);
    expect(world.conversation.sessionId).toBe('decided');
  });

  it('deletes the current session and starts a new conversation', async () => {
    const changeId = await world.proposeEdit();
    const current = world.conversation.sessionId;
    if (current === null) throw new TestFixtureError('the request started no session');
    await world.deleteSession(current);
    expect(world.repository.stored.has(current)).toBe(false);
    expect(world.conversation.sessionId).toBeNull();
    expect(world.conversation.messages()).toEqual([]);
    expect(world.editor.preview).toBeNull();
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
    await expect(world.conversation.takePersistenceFailure()).resolves.toBeNull();
    expect(world.repository.stored.has(current)).toBe(false);
  });

  it('reports a session it could not delete and leaves it listed', async () => {
    await world.openSession('decided');
    world.repository.failing = true;
    await expect(world.deleteSession('decided')).rejects.toThrow(SessionStorageError);
    world.repository.failing = false;
    expect(world.conversation.sessionId).toBeNull();
    await expect(world.listSessions()).resolves.toMatchObject({
      sessions: [{ id: 'decided' }, { id: 'older' }],
    });
  });
});
