import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotATextFileError } from '../../../src/domain/errors';
import { findTextFile, type ProjectFile } from '../../../src/domain/project-file';
import { OverleafEditorBridge } from '../../../src/infrastructure/overleaf/overleaf-editor-bridge';
import {
  OverleafFileTreeContractError,
  OverleafProjectAdapter,
} from '../../../src/infrastructure/overleaf/overleaf-project-adapter';
import {
  OverleafStore,
  OverleafStoreContractError,
  StoreKey,
} from '../../../src/infrastructure/overleaf/overleaf-store';
import {
  CompileTimeoutError,
  FileOpenTimeoutError,
  ProjectFileReadError,
  ProjectUnavailableError,
} from '../../../src/ports/errors';
import { FakeOverleafIde } from '../../support/fake-overleaf';
import { TestFixtureError } from '../../support/test-errors';

const TIMEOUT_MS = 50;

let bridge: OverleafEditorBridge;
let ide: FakeOverleafIde;
let adapter: OverleafProjectAdapter;
let requests: string[];
let answer: () => Promise<Response>;

const file = (path: string): ProjectFile => findTextFile(adapter.listFiles(), path);

beforeEach(() => {
  bridge = new OverleafEditorBridge(() =>
    OverleafStore.fromWindow(window).getString(StoreKey.OpenDocId),
  );
  const uninstall = bridge.install(window);
  ide = new FakeOverleafIde(window);
  requests = [];
  answer = () => Promise.resolve(new Response('@book{knuth84,\r\n}'));
  adapter = new OverleafProjectAdapter({
    window,
    store: OverleafStore.fromWindow(window),
    bridge,
    fetch: (input) => {
      if (typeof input !== 'string') throw new TestFixtureError('the adapter fetches by URL text');
      requests.push(input);
      return answer();
    },
    projectId: 'project-1',
    timeouts: { fileOpenMs: TIMEOUT_MS, compileMs: TIMEOUT_MS },
  });
  return () => {
    uninstall();
  };
});

afterEach(() => {
  ide.destroy();
});

describe('OverleafProjectAdapter files', () => {
  it('lists the project tree and names the open file', () => {
    expect(adapter.listFiles().map(({ path }) => path)).toEqual([
      'main.tex',
      'refs.bib',
      'frog.jpg',
      'chapters/intro/intro.tex',
    ]);
    expect(adapter.openFilePath()).toBe('main.tex');
  });

  it('rejects an open document the project tree does not know', () => {
    ide.store.set('editor.open_doc_id', 'doc-unknown');
    expect(() => adapter.openFilePath()).toThrow(OverleafStoreContractError);
  });

  it('reads the open file from the editor, unsaved edits included', async () => {
    ide.editor.dispatch({ changes: { from: 0, insert: '% draft\n' } });
    const snapshot = await adapter.readFile(file('main.tex'));
    expect(snapshot.lines[0]).toBe('% draft');
    expect(requests).toEqual([]);
  });

  it('reads a file the user is switching to only once its editor shows it', async () => {
    ide.click('doc-refs');
    expect(ide.store.get(StoreKey.OpenDocId)).toBe('doc-refs');
    const snapshot = await adapter.readFile(file('refs.bib'));
    expect(snapshot.lines.join('\n')).toBe(ide.textOf('doc-refs'));
    expect(requests).toEqual([]);
  });

  it('downloads any other file from Overleaf', async () => {
    const snapshot = await adapter.readFile(file('refs.bib'));
    expect(snapshot.lines).toEqual(['@book{knuth84,', '}']);
    expect(requests).toEqual(['/Project/project-1/doc/doc-refs/download']);
  });

  it('classifies a refused download and an unreachable Overleaf', async () => {
    answer = () => Promise.resolve(new Response('', { status: 404 }));
    await expect(adapter.readFile(file('refs.bib'))).rejects.toThrow(ProjectFileReadError);
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(adapter.readFile(file('refs.bib'))).rejects.toThrow(ProjectUnavailableError);
  });

  it('refuses to read or open a binary file', async () => {
    const frog = adapter.listFiles().find(({ path }) => path === 'frog.jpg')!;
    await expect(adapter.readFile(frog)).rejects.toThrow(NotATextFileError);
    await expect(adapter.openFile(frog)).rejects.toThrow(NotATextFileError);
  });
});

describe('OverleafProjectAdapter.openFile', () => {
  it('expands the folders, opens the file and resolves once the editor shows it', async () => {
    await adapter.openFile(file('chapters/intro/intro.tex'));
    expect(ide.isExpanded('folder-chapters')).toBe(true);
    expect(ide.isExpanded('folder-intro')).toBe(true);
    expect(adapter.openFilePath()).toBe('chapters/intro/intro.tex');
    expect(bridge.openEditor?.view.state.doc.toString()).toBe(ide.textOf('doc-intro'));
  });

  it('does nothing when the file is already open', async () => {
    const view = ide.editor;
    await adapter.openFile(file('main.tex'));
    expect(ide.editor).toBe(view);
  });

  it('times out when Overleaf does not open the file and stops watching', async () => {
    ide.opensDocs = false;
    await expect(adapter.openFile(file('refs.bib'))).rejects.toThrow(FileOpenTimeoutError);
    expect(ide.store.watcherCount).toBe(0);
  });

  it('rejects a file tree that does not show the file', async () => {
    document.querySelector('.file-tree')!.replaceChildren();
    await expect(adapter.openFile(file('refs.bib'))).rejects.toThrow(OverleafFileTreeContractError);
  });
});

describe('OverleafProjectAdapter.compile', () => {
  it('recompiles and reports the new log entries', async () => {
    ide.logEntries = {
      errors: [
        { level: 'error', message: 'Undefined control sequence.', file: './main.tex', line: 4 },
      ],
      warnings: [],
      typesetting: [],
      all: [],
    };
    await expect(adapter.compile()).resolves.toEqual([
      { level: 'error', message: 'Undefined control sequence.', path: 'main.tex', lineNumber: 4 },
    ]);
    expect(ide.store.watcherCount).toBe(0);
  });

  it('reports a clean compile that repeats the previous log', async () => {
    await adapter.compile();
    await expect(adapter.compile()).resolves.toEqual([]);
  });

  it('times out when no new log arrives and stops watching', async () => {
    ide.compiles = false;
    await expect(adapter.compile()).rejects.toThrow(CompileTimeoutError);
    expect(ide.store.watcherCount).toBe(0);
  });
});
