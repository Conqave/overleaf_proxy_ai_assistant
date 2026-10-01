import type { ConversationMessage } from '../domain/conversation';
import { sortNewestFirst } from '../domain/session';
import type { EditorPort } from '../ports/editor-port';
import type { SessionRepository } from '../ports/session-repository';
import type { ConversationLog } from './conversation-log';
import { RequestSupersededError } from './errors';
import type { OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';

export class RestoreLatestSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      conversation: ConversationLog;
      lock: OperationLock;
    },
  ) {}

  execute(): Promise<readonly ConversationMessage[]> {
    const { sessions, conversation, lock } = this.deps;
    return lock.run(async () => {
      const epoch = conversation.epoch;
      const [latest] = sortNewestFirst((await sessions.list()).sessions);
      if (latest === undefined) return conversation.messages();
      const session = await sessions.load(latest.id);
      conversation.ensureCurrent(epoch);
      return conversation.show(session);
    });
  }
}

export class StartNewConversation {
  constructor(
    private readonly deps: {
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      editor: EditorPort;
      lock: OperationLock;
    },
  ) {}

  execute(): void {
    this.deps.lock.cancel(new RequestSupersededError());
    if (this.deps.pendingChanges.discardAll().length) this.deps.editor.clearPreview();
    this.deps.conversation.startNew();
  }
}
