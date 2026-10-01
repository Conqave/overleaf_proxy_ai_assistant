import type { EditorPort } from '../ports/editor-port';
import type { ConversationLog } from './conversation-log';
import { RequestSupersededError } from './errors';
import type { OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';

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
    this.deps.conversation.clear();
  }
}
