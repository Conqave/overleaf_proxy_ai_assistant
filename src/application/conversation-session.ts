import type { EditorPort } from '../ports/editor-port';
import type { ConversationLog } from './conversation-log';
import type { PendingChanges } from './pending-change';

export class StartNewConversation {
  constructor(
    private readonly deps: {
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      editor: EditorPort;
    },
  ) {}

  execute(): void {
    if (this.deps.pendingChanges.discardAll().length) this.deps.editor.clearPreview();
    this.deps.conversation.clear();
  }
}
