import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

export const FIXTURE_DOCUMENT = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'This report describes the experiment.',
  '\\section{Results}',
  'The results are shown below.',
  '\\end{document}',
].join('\n');

export function openOverleafEditor(
  window: Window & typeof globalThis,
  parent: HTMLElement,
  text: string = FIXTURE_DOCUMENT,
): EditorView {
  const extensions: Extension[] = [];
  window.dispatchEvent(
    new window.CustomEvent('UNSTABLE_editor:extensions', {
      detail: {
        CodeMirror: { Decoration, EditorView, StateEffect, StateField, ViewPlugin, WidgetType },
        extensions,
      },
    }),
  );
  return new EditorView({ parent, state: EditorState.create({ doc: text, extensions }) });
}
