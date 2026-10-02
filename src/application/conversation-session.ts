import { sortNewestFirst, type SessionSummary } from '../domain/session';
import type { SessionRepository } from '../ports/session-repository';
import type { ConversationLog } from './conversation-log';
import { RequestSupersededError } from './errors';
import { ensureNotCancelled, type OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';

export interface SessionList {
  readonly sessions: readonly SessionSummary[];
  readonly unreadableIds: readonly string[];
  readonly currentId: string | null;
}

export interface SessionDeps {
  readonly sessions: SessionRepository;
  readonly conversation: ConversationLog;
  readonly pendingChanges: PendingChanges;
  readonly lock: OperationLock;
}

export function leaveCurrentSession({ conversation, pendingChanges }: SessionDeps): void {
  pendingChanges.discardAll();
  conversation.startNew();
}

export class RestoreLatestSession {
  constructor(private readonly deps: Pick<SessionDeps, 'sessions' | 'conversation' | 'lock'>) {}

  execute(): Promise<void> {
    const { sessions, conversation, lock } = this.deps;
    return lock.run(async (signal) => {
      const [latest] = sortNewestFirst((await sessions.list()).sessions);
      if (latest === undefined) return;
      const session = await sessions.load(latest.id);
      ensureNotCancelled(signal);
      conversation.show(session);
    });
  }
}

export class ListSessions {
  constructor(private readonly deps: Pick<SessionDeps, 'sessions' | 'conversation'>) {}

  async execute(): Promise<SessionList> {
    const { sessions, unreadableIds } = await this.deps.sessions.list();
    return {
      sessions: sortNewestFirst(sessions),
      unreadableIds,
      currentId: this.deps.conversation.sessionId,
    };
  }
}

export class StartNewConversation {
  constructor(private readonly deps: SessionDeps) {}

  execute(): Promise<void> {
    return this.deps.lock.supersede(new RequestSupersededError(), () => {
      leaveCurrentSession(this.deps);
      return Promise.resolve();
    });
  }
}

export class OpenSession {
  constructor(private readonly deps: SessionDeps) {}

  execute(id: string): Promise<void> {
    const { sessions, conversation, lock } = this.deps;
    return lock.run(async (signal) => {
      const session = await sessions.load(id);
      ensureNotCancelled(signal);
      leaveCurrentSession(this.deps);
      conversation.show(session);
    });
  }
}

export class DeleteSession {
  constructor(private readonly deps: SessionDeps) {}

  execute(id: string): Promise<void> {
    const { sessions, conversation, lock } = this.deps;
    return lock.run(async () => {
      if (conversation.sessionId === id) leaveCurrentSession(this.deps);
      await sessions.delete(id);
    });
  }
}
