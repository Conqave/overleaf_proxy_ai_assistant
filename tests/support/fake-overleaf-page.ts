import type { EditorView } from '@codemirror/view';
import { openOverleafEditor } from './fake-overleaf';
import { TestFixtureError } from './test-errors';

declare global {
  interface Window {
    fakeOverleaf: { open(text?: string): EditorView };
  }
}

window.fakeOverleaf = {
  open(text) {
    const parent = document.getElementById('editor');
    if (!parent) throw new TestFixtureError('the fixture has no #editor element');
    return openOverleafEditor(window, parent, text);
  },
};
