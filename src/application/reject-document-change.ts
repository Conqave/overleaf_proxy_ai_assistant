import { ProposalStatus, type ProposalMessage } from '../domain/conversation';
import type { EditorPort } from '../ports/editor-port';
import type { ConversationLog } from './conversation-log';
import type { PendingChanges } from './pending-change';

export class RejectDocumentChange {
  constructor(
    private readonly deps: {
      editor: EditorPort;
      pendingChanges: PendingChanges;
      conversation: ConversationLog;
    },
  ) {}

  execute(changeId: string): ProposalMessage {
    const change = this.deps.pendingChanges.get(changeId);
    change.reject();
    this.deps.editor.clearPreview();
    return this.deps.conversation.decideProposal(change.id, ProposalStatus.Rejected);
  }
}
