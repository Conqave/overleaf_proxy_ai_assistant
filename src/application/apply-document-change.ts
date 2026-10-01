import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
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
      lock: OperationLock;
      review: ReviewAppliedChange;
    },
  ) {}

  execute(changeId: string, onProgress: (progress: AgentProgress) => void): Promise<ReviewOutcome> {
    return this.deps.lock.run(async () => {
      await this.apply(changeId, onProgress);
      return await this.deps.review.execute(onProgress);
    });
  }

  private async apply(
    changeId: string,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<void> {
    const { editor, project } = this.deps;
    const change = this.deps.pendingChanges.get(changeId);
    const { file, edit } = change.change;
    change.approve();
    try {
      editor.clearPreview();
      await showProjectFile(project, file, onProgress);
      edit.assertCurrent(editor.readDocument());
      editor.apply(edit);
    } catch (error) {
      change.markFailed();
      throw error;
    }
    change.markApplied();
    onProgress({ stage: 'applied', change: change.change });
  }
}
