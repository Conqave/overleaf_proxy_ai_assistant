import type { ProposalMessage } from '../domain/conversation';
import type { EditorPort } from '../ports/editor-port';
import type { OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';

export class RejectDocumentChange {
  constructor(
    private readonly deps: {
      editor: EditorPort;
      pendingChanges: PendingChanges;
      lock: OperationLock;
    },
  ) {}

  execute(changeId: string): Promise<ProposalMessage> {
    return this.deps.lock.run(() => {
      const message = this.deps.pendingChanges.reject(changeId);
      this.deps.editor.clearPreview();
      return Promise.resolve(message);
    });
  }
}
