import type { AgentProgress } from './agent-progress';
import type { ChangeSetDeps } from './change-set-outcome';
import type { ConversationLog } from './conversation-log';
import { ChangeNoLongerPendingError } from './errors';
import type { OperationLock } from './operation-lock';
import { showProjectFile } from './show-project-file';

export class PreviewChangeSetFile {
  constructor(
    private readonly deps: Omit<ChangeSetDeps, 'review'> & {
      readonly conversation: ConversationLog;
      readonly lock: OperationLock;
    },
  ) {}

  execute(
    proposalId: string,
    path: string,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<void> {
    return this.deps.lock.run(async (signal) => {
      const { project, editor, conversation, pendingChanges } = this.deps;
      const epoch = conversation.epoch;
      const pending = pendingChanges.selectFile(proposalId, path);
      const [first] = pending;
      if (first === undefined) throw new ChangeNoLongerPendingError();
      const { file } = first.change;
      await showProjectFile(project, file, onProgress, signal);
      conversation.ensureCurrent(epoch);
      first.change.edit.assertCurrent(editor.readDocument(file));
      editor.showPreview(
        file,
        pending.map(({ change }) => change.edit),
      );
    });
  }
}
