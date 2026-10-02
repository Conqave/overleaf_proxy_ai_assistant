import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFileKind, type ProjectFile } from '../../../src/domain/project-file';
import {
  OverleafFileApiContractError,
  OverleafProjectFiles,
} from '../../../src/infrastructure/overleaf/overleaf-project-files';
import { OverleafStore } from '../../../src/infrastructure/overleaf/overleaf-store';
import {
  ProjectFileReadError,
  ProjectFileWriteError,
  ProjectFileWriteTimeoutError,
  ProjectTreeOutdatedError,
  ProjectUnavailableError,
} from '../../../src/ports/errors';
import { FakeOverleafIde, FIXTURE_ROOT_FOLDER } from '../../support/fake-overleaf';
import { FAKE_CSRF_TOKEN, type FakeOverleafServer } from '../../support/fake-overleaf-server';
import { rejectOnAbort } from '../../support/fakes';
import { TestFixtureError } from '../../support/test-errors';

const PAST_EVERY_DEADLINE_MS = 5 * 60_000;
const EXPORT_PATH = 'hans-sessions/2026-10-02-0705-table.json';

let ide: FakeOverleafIde;
let server: FakeOverleafServer;
let files: OverleafProjectFiles;
let cancel: AbortController;

function createFiles(csrfToken = FAKE_CSRF_TOKEN): OverleafProjectFiles {
  return new OverleafProjectFiles({
    store: OverleafStore.fromWindow(window),
    fetch: server.fetch,
    projectId: 'project-1',
    csrfToken,
  });
}

beforeEach(() => {
  ide = new FakeOverleafIde(window);
  server = ide.server;
  files = createFiles();
  cancel = new AbortController();
});

afterEach(() => {
  vi.useRealTimers();
  ide.destroy();
});

const written = () => server.requests.filter(({ method }) => method === 'POST');

describe('Overleaf project files', () => {
  it('creates the missing folder and uploads the file with its content', async () => {
    await files.write(EXPORT_PATH, '{"a": "\\\\begin"}\n', cancel.signal);
    expect(server.textAt(EXPORT_PATH)).toBe('{"a": "\\\\begin"}\n');
    expect(written().map(({ url }) => url)).toEqual([
      '/project/project-1/folder',
      '/project/project-1/upload?folder_id=folder-new-1',
    ]);
  });

  it('creates the folder once per page and replaces a file of the same name', async () => {
    await files.write(EXPORT_PATH, 'first', cancel.signal);
    await files.write(EXPORT_PATH, 'second', cancel.signal);
    await files.write('hans-sessions/other.json', 'third', cancel.signal);
    expect(written().filter(({ url }) => url.endsWith('/folder'))).toHaveLength(1);
    expect(server.paths()).toEqual(['frog.jpg', EXPORT_PATH, 'hans-sessions/other.json']);
    expect(server.textAt(EXPORT_PATH)).toBe('second');
  });

  it('creates the folder anew after it was deleted', async () => {
    await files.write(EXPORT_PATH, 'first', cancel.signal);
    server.removeFolder('hans-sessions');
    await expect(files.write(EXPORT_PATH, 'second', cancel.signal)).rejects.toThrow(
      ProjectTreeOutdatedError,
    );
    await files.write(EXPORT_PATH, 'third', cancel.signal);
    expect(server.textAt(EXPORT_PATH)).toBe('third');
    expect(written().filter(({ url }) => url.endsWith('/folder'))).toHaveLength(2);
  });

  it('forgets a folder it created once the project tree lists it', async () => {
    await files.write(EXPORT_PATH, 'first', cancel.signal);
    const listed = {
      _id: 'folder-new-1',
      name: 'hans-sessions',
      docs: [],
      fileRefs: [],
      folders: [],
    };
    ide.store.set('project', {
      rootFolder: [{ ...FIXTURE_ROOT_FOLDER, folders: [...FIXTURE_ROOT_FOLDER.folders, listed] }],
    });
    await files.write(EXPORT_PATH, 'second', cancel.signal);
    server.removeFolder('hans-sessions');
    ide.store.set('project', { rootFolder: [FIXTURE_ROOT_FOLDER] });
    await files.write(EXPORT_PATH, 'third', cancel.signal);
    expect(server.textAt(EXPORT_PATH)).toBe('third');
    expect(written().filter(({ url }) => url.endsWith('/folder'))).toHaveLength(2);
  });

  it('uploads into folders the page already knows, at any depth', async () => {
    await files.write('chapters/intro/notes.json', 'x', cancel.signal);
    expect(written().map(({ url }) => url)).toEqual([
      '/project/project-1/upload?folder_id=folder-intro',
    ]);
    await files.write('chapters/new/deeper/notes.json', 'y', cancel.signal);
    expect(server.textAt('chapters/new/deeper/notes.json')).toBe('y');
  });

  it('asks for a reload when the folder was created after the page loaded', async () => {
    await createFiles().write(EXPORT_PATH, 'other tab', cancel.signal);
    await expect(files.write(EXPORT_PATH, 'x', cancel.signal)).rejects.toThrow(
      ProjectTreeOutdatedError,
    );
  });

  it('classifies a refused write, a refused upload and an unreachable Overleaf', async () => {
    await expect(createFiles('stale').write(EXPORT_PATH, 'x', cancel.signal)).rejects.toThrow(
      ProjectFileWriteError,
    );
    server.answersWith = ({ url }) =>
      url.includes('/upload') ? Response.json({ success: false }) : null;
    await expect(files.write(EXPORT_PATH, 'x', cancel.signal)).rejects.toThrow(
      ProjectFileWriteError,
    );
    server.answersWith = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(files.write('x.json', 'x', cancel.signal)).rejects.toThrow(
      ProjectUnavailableError,
    );
  });

  it('rejects answers that break the Overleaf contract', async () => {
    server.answersWith = ({ url }) => (url.endsWith('/folder') ? new Response('{}') : null);
    await expect(files.write(EXPORT_PATH, 'x', cancel.signal)).rejects.toThrow(
      OverleafFileApiContractError,
    );
    server.answersWith = ({ url }) =>
      url.includes('/upload') ? Response.json({ success: true }) : null;
    await expect(files.write('x.json', 'x', cancel.signal)).rejects.toThrow(
      OverleafFileApiContractError,
    );
    server.answersWith = ({ url }) => (url.includes('/upload') ? new Response('<html>') : null);
    await expect(files.write('x.json', 'x', cancel.signal)).rejects.toThrow(
      OverleafFileApiContractError,
    );
  });

  it('gives up on a write that does not finish in time', async () => {
    server.answersWith = () => null;
    const slow = new OverleafProjectFiles({
      store: OverleafStore.fromWindow(window),
      fetch: (_input, init) => rejectOnAbort(signalOf(init)),
      projectId: 'project-1',
      csrfToken: FAKE_CSRF_TOKEN,
    });
    vi.useFakeTimers();
    const outcome = expect(slow.write(EXPORT_PATH, 'x', cancel.signal)).rejects.toThrow(
      ProjectFileWriteTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    await outcome;
  });

  it('reads documents and uploaded files', async () => {
    const doc: ProjectFile = { id: 'doc-refs', path: 'refs.bib', kind: ProjectFileKind.Text };
    const frog: ProjectFile = { id: 'file-frog', path: 'frog.jpg', kind: ProjectFileKind.Binary };
    expect(await files.read(doc, cancel.signal)).toContain('@book{knuth84');
    expect(await files.read(frog, cancel.signal)).toBe('JFIF');
    expect(server.requests.map(({ url }) => url)).toEqual([
      '/Project/project-1/doc/doc-refs/download',
      '/project/project-1/file/file-frog',
    ]);
  });

  it('classifies a deleted file and a refused read', async () => {
    const gone: ProjectFile = { id: 'file-gone', path: 'gone.json', kind: ProjectFileKind.Binary };
    await expect(files.read(gone, cancel.signal)).rejects.toThrow(ProjectTreeOutdatedError);
    server.answersWith = () => new Response('', { status: 500 });
    await expect(files.read(gone, cancel.signal)).rejects.toThrow(ProjectFileReadError);
  });
});

function signalOf(init: RequestInit | undefined): AbortSignal {
  const signal = init?.signal;
  if (!(signal instanceof AbortSignal)) throw new TestFixtureError('every request takes a signal');
  return signal;
}
