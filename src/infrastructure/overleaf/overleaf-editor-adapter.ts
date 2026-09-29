import { createDocumentSnapshot, type DocumentSnapshot } from '../../domain/document';
import type { ResolvedEdit } from '../../domain/resolved-edit';
import type { EditorPort } from '../../ports/editor-port';
import { EditorUnavailableError } from '../../ports/errors';
import { createChange } from './document-change';
import type { OpenEditor, OverleafEditorBridge } from './overleaf-editor-bridge';

const LOGS_SELECTOR = '.logs-pane';

export class OverleafEditorAdapter implements EditorPort {
  constructor(
    private readonly bridge: OverleafEditorBridge,
    private readonly document: Document,
  ) {}

  readDocument(): DocumentSnapshot {
    return createDocumentSnapshot(this.editor().view.state.doc.toJSON());
  }

  readSelection(): string {
    const { state } = this.editor().view;
    const { from, to } = state.selection.main;
    return state.sliceDoc(from, to).trim();
  }

  readCursorLine(): number {
    const { state } = this.editor().view;
    return state.doc.lineAt(state.selection.main.head).number;
  }

  readCompileLogs(): string {
    const logs = this.document.querySelector(LOGS_SELECTOR);
    if (logs === null) return '';
    return logs.textContent.replace(/\u00a0/g, ' ').trim();
  }

  showPreview(edit: ResolvedEdit): void {
    const { view, preview } = this.editor();
    preview.show(view, edit.command);
  }

  clearPreview(): void {
    const editor = this.bridge.openEditor;
    editor?.preview.clear(editor.view);
  }

  apply(edit: ResolvedEdit): void {
    const { view } = this.editor();
    view.dispatch({
      changes: createChange(view.state.doc, edit.command),
      scrollIntoView: true,
      userEvent: 'input',
    });
  }

  private editor(): OpenEditor {
    const editor = this.bridge.openEditor;
    if (!editor) throw new EditorUnavailableError('The Overleaf editor is not available.');
    return editor;
  }
}
