import type { ProjectEdit } from '../domain/agent-action';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { PendingChanges } from './pending-change';
import { showProjectFile } from './show-project-file';

export class ApplyDocumentChange {
  constructor(
    private readonly deps: {
      editor: EditorPort;
      project: ProjectPort;
      pendingChanges: PendingChanges;
    },
  ) {}

  async execute(
    changeId: string,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<ProjectEdit> {
    const { editor, project } = this.deps;
    const change = this.deps.pendingChanges.get(changeId);
    const { path, edit } = change.change;
    change.approve();
    try {
      editor.clearPreview();
      await showProjectFile(project, path, onProgress);
      edit.assertCurrent(editor.readDocument());
      editor.apply(edit);
    } catch (error) {
      change.markFailed();
      throw error;
    }
    change.markApplied();
    return change.change;
  }
}
