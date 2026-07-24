import type { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { DocumentRangeError, InvariantViolation } from '../../../src/domain/errors';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';
import {
  getExtensionsEventDetail,
  OverleafHookContractError,
} from '../../../src/infrastructure/overleaf/codemirror-api';
import { OverleafEditorAdapter } from '../../../src/infrastructure/overleaf/overleaf-editor-adapter';
import { OverleafEditorBridge } from '../../../src/infrastructure/overleaf/overleaf-editor-bridge';
import { EditorUnavailableError } from '../../../src/ports/errors';
import { FIXTURE_DOCUMENT, openOverleafEditor } from '../../support/fake-overleaf';

let bridge: OverleafEditorBridge;
let adapter: OverleafEditorAdapter;
let editor: EditorView;

const lines = () => editor.state.doc.toJSON();
const edit = (input: Parameters<typeof createDocumentCommand>[0]): ResolvedEdit =>
  ResolvedEdit.resolve(createDocumentSnapshot(lines()), createDocumentCommand(input));
const results = { lineNumber: 6, lineText: 'The results are shown below.' };

function open(text: string = FIXTURE_DOCUMENT): EditorView {
  document.body.innerHTML = '<div id="editor"></div><div class="logs-pane">x:4: Undefined.</div>';
  return openOverleafEditor(window, document.getElementById('editor')!, text);
}

beforeEach(() => {
  bridge = new OverleafEditorBridge();
  const uninstall = bridge.install(window);
  adapter = new OverleafEditorAdapter(bridge, document);
  editor = open();
  return () => {
    uninstall();
    editor.destroy();
  };
});

describe('OverleafEditorBridge', () => {
  it('rejects an extension hook that does not carry what Overleaf promises', () => {
    const withoutClasses = new CustomEvent('UNSTABLE_editor:extensions', {
      detail: { CodeMirror: {}, extensions: [] },
    });
    expect(() => getExtensionsEventDetail(withoutClasses)).toThrow(OverleafHookContractError);
    expect(() => getExtensionsEventDetail(new Event('UNSTABLE_editor:extensions'))).toThrow(
      OverleafHookContractError,
    );
  });

  it('extends every editor Overleaf creates and follows the open one', async () => {
    await expect(bridge.whenReady()).resolves.toBeUndefined();
    expect(bridge.openEditor?.view).toBe(editor);
    editor.destroy();
    expect(bridge.openEditor).toBeNull();
    editor = open('\\section{Other file}');
    expect(bridge.openEditor?.view).toBe(editor);
  });
});

describe('OverleafEditorAdapter', () => {
  it('reads the whole document from the editor state', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `Line ${String(i + 1)}`).join('\n');
    editor.destroy();
    editor = open(long);
    const snapshot = adapter.readDocument();
    expect(snapshot.lines).toHaveLength(5000);
    expect(snapshot.lines.at(-1)).toBe('Line 5000');
  });

  it('reads selection and caret line from the editor state', () => {
    expect(adapter.readSelection()).toBe('');
    expect(adapter.readCursorLine()).toBe(1);
    const line = editor.state.doc.line(4);
    editor.dispatch({ selection: { anchor: line.from + 5, head: line.to } });
    expect(adapter.readSelection()).toBe('report describes the experiment.');
    expect(adapter.readCursorLine()).toBe(4);
  });

  it('reads compile logs', () => {
    expect(adapter.readCompileLogs()).toBe('x:4: Undefined.');
  });

  it('inserts before the target line', () => {
    adapter.apply(edit({ operation: 'insert_before', target: results, content: 'A\nB' }));
    expect(lines().slice(5, 8)).toEqual(['A', 'B', 'The results are shown below.']);
  });

  it('inserts after the target line', () => {
    adapter.apply(edit({ operation: 'insert_after', target: results, content: 'After.' }));
    expect(lines().slice(5, 7)).toEqual(['The results are shown below.', 'After.']);
  });

  it('replaces the target line', () => {
    adapter.apply(edit({ operation: 'replace', target: results, lineCount: 1, content: 'New.' }));
    expect(lines()[5]).toBe('New.');
    expect(lines()).toHaveLength(7);
  });

  it('deletes the target line with its line break', () => {
    adapter.apply(edit({ operation: 'delete', target: results, lineCount: 1 }));
    expect(lines()).toEqual(FIXTURE_DOCUMENT.split('\n').filter((l) => l !== results.lineText));
  });

  it('deletes the last and the only line without leaving an empty line', () => {
    const last = { lineNumber: 7, lineText: '\\end{document}' };
    adapter.apply(edit({ operation: 'delete', target: last, lineCount: 1 }));
    expect(lines().at(-1)).toBe('The results are shown below.');
    editor.destroy();
    editor = open('only');
    adapter.apply(
      edit({ operation: 'delete', target: { lineNumber: 1, lineText: 'only' }, lineCount: 1 }),
    );
    expect(lines()).toEqual(['']);
  });

  it('replaces a range of lines', () => {
    const section = { lineNumber: 5, lineText: '\\section{Results}' };
    adapter.apply(
      edit({ operation: 'replace', target: section, lineCount: 2, content: 'X\nY\nZ' }),
    );
    expect(lines().slice(4)).toEqual(['X', 'Y', 'Z', '\\end{document}']);
  });

  it('deletes a range of lines, also up to the end of the document', () => {
    const intro = { lineNumber: 3, lineText: '\\section{Introduction}' };
    adapter.apply(edit({ operation: 'delete', target: intro, lineCount: 2 }));
    expect(lines()).toEqual([
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{Results}',
      'The results are shown below.',
      '\\end{document}',
    ]);
    const results2 = { lineNumber: 3, lineText: '\\section{Results}' };
    adapter.apply(edit({ operation: 'delete', target: results2, lineCount: 3 }));
    expect(lines()).toEqual(['\\documentclass{article}', '\\begin{document}']);
  });

  it('refuses a range that runs past the end of the document', () => {
    expect(() => {
      adapter.apply(edit({ operation: 'delete', target: results, lineCount: 3 }));
    }).toThrow(DocumentRangeError);
    expect(lines()).toEqual(FIXTURE_DOCUMENT.split('\n'));
  });

  it('treats an edit resolved against another document as a defect', () => {
    const stale = edit({ operation: 'delete', target: results, lineCount: 1 });
    const line = editor.state.doc.line(6);
    editor.dispatch({ changes: { from: line.from, to: line.to, insert: 'Edited meanwhile.' } });
    expect(() => {
      adapter.apply(stale);
    }).toThrow(InvariantViolation);
    expect(() => {
      adapter.showPreview(stale);
    }).toThrow(InvariantViolation);
    expect(lines()[5]).toBe('Edited meanwhile.');
  });

  it('reports a missing editor', () => {
    editor.destroy();
    expect(() => adapter.readDocument()).toThrow(EditorUnavailableError);
    expect(() => {
      adapter.apply(edit({ operation: 'delete', target: results, lineCount: 1 }));
    }).toThrow(EditorUnavailableError);
    expect(() => {
      adapter.clearPreview();
    }).not.toThrow();
  });

  describe('preview', () => {
    const shown = (selector: string) =>
      Array.from(editor.dom.querySelectorAll(selector), (node) => node.textContent);

    it('marks the target and shows added lines without changing the document', () => {
      adapter.showPreview(edit({ operation: 'insert_after', target: results, content: 'X\nY' }));
      expect(shown('.ola-preview-target')).toEqual([results.lineText]);
      expect(shown('.ola-preview-added')).toEqual(['XY']);
      expect(lines()).toEqual(FIXTURE_DOCUMENT.split('\n'));
    });

    it('strikes through a line that a replace or delete would remove', () => {
      adapter.showPreview(
        edit({ operation: 'replace', target: results, lineCount: 1, content: 'Z' }),
      );
      expect(shown('.ola-preview-removed')).toEqual([results.lineText]);
      expect(shown('.ola-preview-added')).toEqual(['Z']);
      adapter.showPreview(edit({ operation: 'delete', target: results, lineCount: 1 }));
      expect(shown('.ola-preview-removed')).toEqual([results.lineText]);
      expect(shown('.ola-preview-added')).toEqual([]);
    });

    it('strikes through every line of a range and shows the replacement after it', () => {
      const intro = { lineNumber: 3, lineText: '\\section{Introduction}' };
      adapter.showPreview(
        edit({ operation: 'replace', target: intro, lineCount: 2, content: 'New' }),
      );
      expect(shown('.ola-preview-removed')).toEqual([
        '\\section{Introduction}',
        'This report describes the experiment.',
      ]);
      expect(shown('.ola-preview-added')).toEqual(['New']);
    });

    it('is removed by clearPreview', () => {
      adapter.showPreview(edit({ operation: 'insert_before', target: results, content: 'P' }));
      adapter.clearPreview();
      expect(shown('.ola-preview-target, .ola-preview-added')).toEqual([]);
    });
  });
});
