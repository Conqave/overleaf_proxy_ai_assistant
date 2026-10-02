import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectFileKind, type ProjectFile } from '../../../src/domain/project-file';
import type { SessionExport } from '../../../src/domain/session-export';
import { OverleafProjectFiles } from '../../../src/infrastructure/overleaf/overleaf-project-files';
import { OverleafStore } from '../../../src/infrastructure/overleaf/overleaf-store';
import { ProjectSessionArchive } from '../../../src/infrastructure/persistence/project-session-archive';
import { SESSION_EXPORT_FORMAT } from '../../../src/infrastructure/persistence/session-export-format';
import { UnreadableSessionExportError } from '../../../src/ports/errors';
import {
  FakeOverleafIde,
  FIXTURE_FILE_TEXTS,
  FIXTURE_ROOT_FOLDER,
} from '../../support/fake-overleaf';
import { FAKE_CSRF_TOKEN } from '../../support/fake-overleaf-server';

const PATH = 'hans-sessions/2026-10-02-0705-table.json';
const exported: SessionExport = {
  projectId: 'project-1',
  exportedBy: 'user-1',
  exportedAt: 5,
  session: {
    title: 'Table',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'u1', role: 'user', text: 'Add \\begin{table}' }],
  },
};
const SESSIONS_FOLDER = {
  _id: 'folder-sessions',
  name: 'hans-sessions',
  docs: [],
  fileRefs: [
    { _id: 'file-export', name: 'export.json' },
    { _id: 'file-corrupt', name: 'corrupt.json' },
  ],
  folders: [],
};

let ide: FakeOverleafIde;
let archive: ProjectSessionArchive;
const signal = new AbortController().signal;
const binary = (id: string, name: string): ProjectFile => ({
  id,
  path: `hans-sessions/${name}`,
  kind: ProjectFileKind.Binary,
});

beforeEach(() => {
  const exportText = JSON.stringify({ format: SESSION_EXPORT_FORMAT, ...exported });
  ide = new FakeOverleafIde(
    window,
    { ...FIXTURE_ROOT_FOLDER, folders: [...FIXTURE_ROOT_FOLDER.folders, SESSIONS_FOLDER] },
    new Map([...FIXTURE_FILE_TEXTS, ['file-export', exportText], ['file-corrupt', '{"format":']]),
  );
  archive = new ProjectSessionArchive(
    new OverleafProjectFiles({
      store: OverleafStore.fromWindow(window),
      fetch: ide.server.fetch,
      projectId: 'project-1',
      csrfToken: FAKE_CSRF_TOKEN,
    }),
  );
});

afterEach(() => {
  ide.destroy();
});

describe('project session archive', () => {
  it('writes an export as a project file that reads back unchanged', async () => {
    await archive.save('hans-sessions/new.json', exported, signal);
    expect(JSON.parse(ide.server.textAt('hans-sessions/new.json'))).toMatchObject({
      format: SESSION_EXPORT_FORMAT,
      exportedBy: 'user-1',
    });
    expect(ide.server.requests.filter(({ url }) => url.endsWith('/folder'))).toEqual([]);
    await expect(archive.load(binary('file-export', 'export.json'), signal)).resolves.toEqual(
      exported,
    );
  });

  it('refuses a file that is no session export', async () => {
    await expect(archive.load(binary('file-corrupt', 'corrupt.json'), signal)).rejects.toThrow(
      UnreadableSessionExportError,
    );
    await expect(
      archive.load({ id: 'doc-refs', path: PATH, kind: ProjectFileKind.Text }, signal),
    ).rejects.toThrow(UnreadableSessionExportError);
  });
});
