import { ProposalStatus } from '../domain/conversation';
import type { CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import type { OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';
import type { ReviewAppliedChange, ReviewOutcome } from './review-applied-change';
import { showProjectFile } from './show-project-file';

export class ApplyDocumentChange {
  constructor(
    private readonly deps: {
      editor: EditorPort;
      project: ProjectPort;
      pendingChanges: PendingChanges;
      conversation: ConversationLog;
      lock: OperationLock;
      review: ReviewAppliedChange;
    },
  ) {}

  execute(changeId: string, onProgress: (progress: AgentProgress) => void): Promise<ReviewOutcome> {
    return this.deps.lock.run(async (signal) => {
      await this.apply(changeId, onProgress, signal);
      return await this.deps.review.execute(onProgress, signal);
    });
  }

  private async apply(
    changeId: string,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<void> {
    const { editor, project, conversation } = this.deps;
    const epoch = conversation.epoch;
    const change = this.deps.pendingChanges.get(changeId);
    const { file, edit } = change.change;
    change.approve();
    try {
      editor.clearPreview();
      await showProjectFile(project, file, onProgress, signal);
      edit.assertCurrent(editor.readDocument(file));
      editor.apply(file, edit);
    } catch (error) {
      change.markFailed();
      throw error;
    }
    change.markApplied();
    conversation.ensureCurrent(epoch);
    const message = conversation.decideProposal(change.id, ProposalStatus.Applied);
    onProgress({ stage: 'applied', change: change.change, message });
  }
}
