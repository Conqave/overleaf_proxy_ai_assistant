import { createDocumentSnapshot, type DocumentSnapshot } from '../../domain/document';
import type { FileChange } from '../../domain/file-change';
import type { TextFile } from '../../domain/project-file';
import type { ResolvedEdit } from '../../domain/resolved-edit';
import type { EditorPort } from '../../ports/editor-port';
import { EditorShowsOtherFileError, EditorUnavailableError } from '../../ports/errors';
import { createSpliceChange } from './document-change';
import type { OpenEditor, OverleafEditorBridge } from './overleaf-editor-bridge';

export class OverleafEditorAdapter implements EditorPort {
  constructor(private readonly bridge: OverleafEditorBridge) {}

  readDocument(file: TextFile): DocumentSnapshot {
    return createDocumentSnapshot(this.editor(file).view.state.doc.toJSON());
  }

  readSelection(file: TextFile): string {
    const { state } = this.editor(file).view;
    const { from, to } = state.selection.main;
    return state.sliceDoc(from, to).trim();
  }

  readCursorLine(file: TextFile): number {
    const { state } = this.editor(file).view;
    return state.doc.lineAt(state.selection.main.head).number;
  }

  showPreview(file: TextFile, edits: readonly ResolvedEdit[]): void {
    const { view, preview } = this.editor(file);
    preview.show(
      view,
      edits.map(({ command }) => command),
    );
  }

  clearPreview(): void {
    const editor = this.bridge.openEditor;
    editor?.preview.clear(editor.view);
  }

  apply(file: TextFile, change: FileChange): void {
    const { view } = this.editor(file);
    const { doc } = view.state;
    view.dispatch({
      changes: change.splices.map((splice) => createSpliceChange(doc, splice)),
      scrollIntoView: true,
      userEvent: 'input',
    });
  }

  private editor(file: TextFile): OpenEditor {
    const editor = this.bridge.openEditor;
    if (!editor) throw new EditorUnavailableError('The Overleaf editor is not available.');
    if (editor.docId !== file.id) {
      throw new EditorShowsOtherFileError(
        `The editor no longer shows ${file.path}; wait until it does and try again.`,
      );
    }
    return editor;
  }
}
