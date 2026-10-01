import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NamedError, ProjectFileNotFoundError } from '../../../src/domain/errors';
import { findTextFile, type TextFile } from '../../../src/domain/project-file';
import { OverleafEditorBridge } from '../../../src/infrastructure/overleaf/overleaf-editor-bridge';
import {
  OverleafFileTreeContractError,
  OverleafProjectAdapter,
} from '../../../src/infrastructure/overleaf/overleaf-project-adapter';
import { OverleafToolbarContractError } from '../../../src/infrastructure/overleaf/overleaf-compiler';
import { OverleafStore, StoreKey } from '../../../src/infrastructure/overleaf/overleaf-store';
import {
  CompileTimeoutError,
  CompileWithoutResultError,
  EditsNotSavedError,
  FileOpenTimeoutError,
  NoOpenTextFileError,
  ProjectFileReadError,
  ProjectFileReadTimeoutError,
  ProjectTreeOutdatedError,
  ProjectUnavailableError,
} from '../../../src/ports/errors';
import { EMPTY_LOG_ENTRIES, FakeOverleafIde } from '../../support/fake-overleaf';
import { rejectOnAbort } from '../../support/fakes';
import { TestFixtureError } from '../../support/test-errors';

const PAST_EVERY_DEADLINE_MS = 5 * 60_000;

class RequestCancelledForTest extends NamedError {}

let bridge: OverleafEditorBridge;
let ide: FakeOverleafIde;
let adapter: OverleafProjectAdapter;
let requests: string[];
let answer: (signal: AbortSignal) => Promise<Response>;
let cancel: AbortController;

const file = (path: string): TextFile => findTextFile(adapter.listFiles(), path);

beforeEach(() => {
  bridge = new OverleafEditorBridge(() =>
    OverleafStore.fromWindow(window).getString(StoreKey.OpenDocId),
  );
  const uninstall = bridge.install(window);
  ide = new FakeOverleafIde(window);
  requests = [];
  cancel = new AbortController();
  answer = () => Promise.resolve(new Response('@book{knuth84,\r\n}'));
  adapter = new OverleafProjectAdapter({
    window,
    store: OverleafStore.fromWindow(window),
    bridge,
    fetch: (input, init) => {
      if (typeof input !== 'string') throw new TestFixtureError('the adapter fetches by URL text');
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new TestFixtureError('downloads take a signal');
      requests.push(input);
      return answer(signal);
    },
    projectId: 'project-1',
  });
  return () => {
    uninstall();
  };
});

afterEach(() => {
  vi.useRealTimers();
  ide.destroy();
});

async function expectFailurePastDeadlines(
  operation: () => Promise<unknown>,
  error: new (...args: never[]) => Error,
): Promise<void> {
  vi.useFakeTimers();
  const outcome = expect(operation()).rejects.toThrow(error);
  await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
  await outcome;
}

describe('OverleafProjectAdapter files', () => {
  it('lists the project tree and names the open file', () => {
    expect(adapter.listFiles().map(({ path }) => path)).toEqual([
      'main.tex',
      'refs.bib',
      'frog.jpg',
      'chapters/intro/intro.tex',
    ]);
    expect(adapter.shownFile()).toEqual(file('main.tex'));
    expect(adapter.isShown(file('main.tex'))).toBe(true);
    expect(adapter.isShown(file('refs.bib'))).toBe(false);
  });

  it('reports an open document added after the page loaded', () => {
    ide.store.set('editor.open_doc_id', 'doc-added');
    expect(() => adapter.shownFile()).toThrow(ProjectTreeOutdatedError);
  });

  it('names no open file while Overleaf shows a binary file', () => {
    ide.click('file-frog');
    expect(() => adapter.shownFile()).toThrow(NoOpenTextFileError);
    expect(adapter.isShown(file('main.tex'))).toBe(false);
  });

  it('reads the open file from the editor, unsaved edits included', async () => {
    ide.editor.dispatch({ changes: { from: 0, insert: '% draft\n' } });
    const snapshot = await adapter.readFile(file('main.tex'), cancel.signal);
    expect(snapshot.lines[0]).toBe('% draft');
    expect(requests).toEqual([]);
  });

  it('reads a file the user is switching to only once its editor shows it', async () => {
    ide.click('doc-refs');
    expect(ide.store.get(StoreKey.OpenDocId)).toBe('doc-refs');
    const snapshot = await adapter.readFile(file('refs.bib'), cancel.signal);
    expect(snapshot.lines.join('\n')).toBe(ide.textOf('doc-refs'));
    expect(requests).toEqual([]);
  });

  it('downloads any other file from Overleaf', async () => {
    const snapshot = await adapter.readFile(file('refs.bib'), cancel.signal);
    expect(snapshot.lines).toEqual(['@book{knuth84,', '}']);
    expect(requests).toEqual(['/Project/project-1/doc/doc-refs/download']);
  });

  it('classifies a deleted file, a refused download and an unreachable Overleaf', async () => {
    answer = () => Promise.resolve(new Response('', { status: 404 }));
    await expect(adapter.readFile(file('refs.bib'), cancel.signal)).rejects.toThrow(
      ProjectFileNotFoundError,
    );
    answer = () => Promise.resolve(new Response('', { status: 500 }));
    await expect(adapter.readFile(file('refs.bib'), cancel.signal)).rejects.toThrow(
      ProjectFileReadError,
    );
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(adapter.readFile(file('refs.bib'), cancel.signal)).rejects.toThrow(
      ProjectUnavailableError,
    );
  });
});

describe('OverleafProjectAdapter download limits', () => {
  it('gives up on a download that does not finish in time', async () => {
    answer = rejectOnAbort;
    await expectFailurePastDeadlines(
      () => adapter.readFile(file('refs.bib'), cancel.signal),
      ProjectFileReadTimeoutError,
    );
  });

  it('stops a download when the request is cancelled', async () => {
    answer = rejectOnAbort;
    const reading = adapter.readFile(file('refs.bib'), cancel.signal);
    const reason = new RequestCancelledForTest('new chat');
    cancel.abort(reason);
    await expect(reading).rejects.toBe(reason);
  });
});

describe('OverleafProjectAdapter.openFile', () => {
  it('expands the folders, opens the file and resolves once the editor shows it', async () => {
    await adapter.openFile(file('chapters/intro/intro.tex'), cancel.signal);
    expect(ide.isExpanded('folder-chapters')).toBe(true);
    expect(ide.isExpanded('folder-intro')).toBe(true);
    expect(adapter.shownFile().path).toBe('chapters/intro/intro.tex');
    expect(bridge.openEditor?.view.state.doc.toString()).toBe(ide.textOf('doc-intro'));
  });

  it('brings the last document back when a binary file hides it', async () => {
    const view = ide.editor;
    ide.click('file-frog');
    await adapter.openFile(file('main.tex'), cancel.signal);
    expect(adapter.shownFile().path).toBe('main.tex');
    expect(ide.editor).toBe(view);
  });

  it('does nothing when the file is already open', async () => {
    const view = ide.editor;
    await adapter.openFile(file('main.tex'), cancel.signal);
    expect(ide.editor).toBe(view);
  });

  it('times out when Overleaf does not open the file and stops watching', async () => {
    ide.opensDocs = false;
    await expectFailurePastDeadlines(
      () => adapter.openFile(file('refs.bib'), cancel.signal),
      FileOpenTimeoutError,
    );
    expect(ide.store.watcherCount).toBe(0);
  });

  it('reports a file deleted since the page loaded', async () => {
    ide.remove('doc-refs');
    await expect(adapter.openFile(file('refs.bib'), cancel.signal)).rejects.toThrow(
      ProjectFileNotFoundError,
    );
  });

  it('rejects a page without a file tree', async () => {
    ide.removeFileTree();
    await expect(adapter.openFile(file('refs.bib'), cancel.signal)).rejects.toThrow(
      OverleafFileTreeContractError,
    );
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
    await expect(adapter.compile(cancel.signal)).resolves.toEqual([
      { level: 'error', message: 'Undefined control sequence.', path: 'main.tex', lineNumber: 4 },
    ]);
    expect(ide.store.watcherCount).toBe(0);
  });

  it('reports a clean compile that repeats the previous log', async () => {
    await adapter.compile(cancel.signal);
    await expect(adapter.compile(cancel.signal)).resolves.toEqual([]);
  });

  it('waits for a compile already running and then recompiles', async () => {
    window.dispatchEvent(new CustomEvent('pdf:recompile'));
    await adapter.compile(cancel.signal);
    expect(ide.compileCount).toBe(2);
  });

  it('rejects a toolbar without the Recompile button', async () => {
    ide.removeToolbar();
    await expect(adapter.compile(cancel.signal)).rejects.toThrow(OverleafToolbarContractError);
  });

  it('stops waiting for the compile when the request is cancelled', async () => {
    ide.compiles = false;
    const compiling = adapter.compile(cancel.signal);
    const reason = new RequestCancelledForTest('new chat');
    cancel.abort(reason);
    await expect(compiling).rejects.toBe(reason);
    expect(ide.store.watcherCount).toBe(0);
  });

  it('sends the pending edits of the open document and compiles once Overleaf has them', async () => {
    ide.sharedDocument.bufferedOps = true;
    const compiledWithBufferedOps: boolean[] = [];
    const recordState = (): void => {
      compiledWithBufferedOps.push(ide.sharedDocument.bufferedOps);
    };
    window.addEventListener('pdf:recompile', recordState);
    try {
      await adapter.compile(cancel.signal);
    } finally {
      window.removeEventListener('pdf:recompile', recordState);
    }
    expect(ide.sharedDocument.flushes).toBe(1);
    expect(compiledWithBufferedOps).toEqual([false]);
  });

  it('refuses to compile while Overleaf has not saved the latest edits', async () => {
    ide.sharedDocument.bufferedOps = true;
    ide.sharedDocument.savesEdits = false;
    await expectFailurePastDeadlines(() => adapter.compile(cancel.signal), EditsNotSavedError);
    expect(ide.compileCount).toBe(0);
  });

  it('compiles without an open shared document', async () => {
    ide.store.set('editor.sharejs_doc', null);
    await expect(adapter.compile(cancel.signal)).resolves.toEqual([]);
  });

  it('times out when Overleaf never runs the compile and stops watching', async () => {
    ide.compiles = false;
    await expectFailurePastDeadlines(() => adapter.compile(cancel.signal), CompileTimeoutError);
    expect(ide.store.watcherCount).toBe(0);
  });

  it('reports a compile that ends without any log long before the compile timeout', async () => {
    ide.compileOutcome = 'http-error';
    await expectFailurePastDeadlines(
      () => adapter.compile(cancel.signal),
      CompileWithoutResultError,
    );
    expect(ide.store.watcherCount).toBe(0);
  });

  it('reports a compile that ends with an empty log and no new PDF', async () => {
    ide.compileOutcome = 'no-output';
    await expectFailurePastDeadlines(
      () => adapter.compile(cancel.signal),
      CompileWithoutResultError,
    );
  });

  it('takes a log that Overleaf publishes together with the end of the compile', async () => {
    ide.compileOutcome = 'pdf-with-idle';
    ide.logEntries = { ...EMPTY_LOG_ENTRIES, errors: [{ message: 'Undefined control sequence.' }] };
    await expect(adapter.compile(cancel.signal)).resolves.toEqual([
      { level: 'error', message: 'Undefined control sequence.' },
    ]);
  });

  it('ignores the log of an earlier compile that arrives while it compiles', async () => {
    const late = {
      ...EMPTY_LOG_ENTRIES,
      errors: [{ level: 'error', message: 'Stale error.', file: './main.tex', line: 1 }],
    };
    const publishLateLog = (): void => {
      ide.store.set('pdf.logEntries', late);
    };
    window.addEventListener('pdf:recompile', publishLateLog);
    try {
      await expect(adapter.compile(cancel.signal)).resolves.toEqual([]);
    } finally {
      window.removeEventListener('pdf:recompile', publishLateLog);
    }
  });
});
