import { ProposalStatus } from '../domain/conversation';
import { DocumentConflictError } from '../domain/errors';
import type { CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { FailureRecordingError } from './errors';
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
    const { editor, project, conversation, pendingChanges } = this.deps;
    const epoch = conversation.epoch;
    const { file, edit } = pendingChanges.approve(changeId).change;
    let writing = false;
    try {
      await showProjectFile(project, file, onProgress, signal);
      conversation.ensureCurrent(epoch);
      editor.clearPreview();
      edit.assertCurrent(editor.readDocument(file));
      writing = true;
      editor.apply(file, edit);
    } catch (error) {
      this.recordFailure(
        changeId,
        writing || error instanceof DocumentConflictError,
        onProgress,
        error,
      );
      throw error;
    }
    const message = pendingChanges.settle(changeId, ProposalStatus.Applied);
    onProgress({ stage: 'decided', message });
  }

  private recordFailure(
    changeId: string,
    isFinal: boolean,
    onProgress: (progress: AgentProgress) => void,
    failure: unknown,
  ): void {
    const { pendingChanges } = this.deps;
    if (!pendingChanges.isPending(changeId)) return;
    try {
      if (isFinal) {
        onProgress({
          stage: 'decided',
          message: pendingChanges.settle(changeId, ProposalStatus.Failed),
        });
      } else {
        pendingChanges.withdrawApproval(changeId);
      }
    } catch (recordingError) {
      throw new FailureRecordingError(failure, recordingError);
    }
  }
}
