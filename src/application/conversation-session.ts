import { sortNewestFirst, type SessionSummary } from '../domain/session';
import type { EditorPort } from '../ports/editor-port';
import type { SessionRepository } from '../ports/session-repository';
import type { ConversationLog } from './conversation-log';
import { RequestSupersededError } from './errors';
import type { OperationLock } from './operation-lock';
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
  readonly editor: EditorPort;
  readonly lock: OperationLock;
}

export function leaveCurrentSession({ conversation, pendingChanges, editor }: SessionDeps): void {
  if (pendingChanges.discardAll().length) editor.clearPreview();
  conversation.startNew();
}

export class RestoreLatestSession {
  constructor(private readonly deps: Pick<SessionDeps, 'sessions' | 'conversation' | 'lock'>) {}

  execute(): Promise<void> {
    const { sessions, conversation, lock } = this.deps;
    return lock.run(async () => {
      const epoch = conversation.epoch;
      const [latest] = sortNewestFirst((await sessions.list()).sessions);
      if (latest === undefined) return;
      const session = await sessions.load(latest.id);
      conversation.ensureCurrent(epoch);
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

  execute(): void {
    this.deps.lock.cancel(new RequestSupersededError());
    leaveCurrentSession(this.deps);
  }
}

export class OpenSession {
  constructor(private readonly deps: SessionDeps) {}

  execute(id: string): Promise<void> {
    const { sessions, conversation, lock } = this.deps;
    return lock.run(async () => {
      const epoch = conversation.epoch;
      const session = await sessions.load(id);
      conversation.ensureCurrent(epoch);
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
