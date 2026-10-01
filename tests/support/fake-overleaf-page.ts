import type { EditorView } from '@codemirror/view';
import { FIXTURE_DOC_ID, openOverleafEditor } from './fake-overleaf';
import { FakeOverleafStore } from './fake-overleaf-store';
import { TestFixtureError } from './test-errors';

declare global {
  interface Window {
    fakeOverleaf: { open(text?: string): EditorView };
  }
}

Object.assign(window, {
  overleaf: {
    unstable: { store: new FakeOverleafStore({ 'editor.open_doc_id': FIXTURE_DOC_ID }) },
  },
});

window.fakeOverleaf = {
  open(text) {
    const parent = document.getElementById('editor');
    if (!parent) throw new TestFixtureError('the fixture has no #editor element');
    return openOverleafEditor(window, parent, text);
  },
};
