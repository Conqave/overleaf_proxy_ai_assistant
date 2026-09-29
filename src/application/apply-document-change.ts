import type { DocumentCommand } from '../domain/document-command';
import type { EditorPort } from '../ports/editor-port';
import type { PendingChanges } from './pending-change';

export class ApplyDocumentChange {
  constructor(private readonly deps: { editor: EditorPort; pendingChanges: PendingChanges }) {}

  execute(changeId: string): DocumentCommand {
    const { editor } = this.deps;
    const change = this.deps.pendingChanges.get(changeId);
    change.approve();
    try {
      editor.clearPreview();
      change.edit.assertCurrent(editor.readDocument());
      editor.apply(change.edit);
    } catch (error) {
      change.markFailed();
      throw error;
    }
    change.markApplied();
    return change.edit.command;
  }
}
