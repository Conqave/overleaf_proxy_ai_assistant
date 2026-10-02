import type { AgentProgress } from './agent-progress';
import type { ChangeSetDeps } from './change-set-outcome';
import { ChangeNoLongerPendingError } from './errors';
import { recordingFailure } from './notices';
import { ensureNotCancelled, type OperationLock } from './operation-lock';
import { showProjectFile } from './show-project-file';

export class PreviewChangeSetFile {
  constructor(
    private readonly deps: Omit<ChangeSetDeps, 'review'> & { readonly lock: OperationLock },
  ) {}

  execute(
    proposalId: string,
    path: string,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<void> {
    const { project, editor, pendingChanges, conversation, lock } = this.deps;
    return lock.run((signal) =>
      recordingFailure(conversation, async () => {
        const pending = pendingChanges.selectFile(proposalId, path);
        const [first] = pending;
        if (first === undefined) throw new ChangeNoLongerPendingError();
        const { file } = first.change;
        await showProjectFile(project, file, onProgress, signal);
        ensureNotCancelled(signal);
        first.change.edit.assertCurrent(editor.readDocument(file));
        editor.showPreview(
          file,
          pending.map(({ change }) => change.edit),
        );
      }),
    );
  }
}
