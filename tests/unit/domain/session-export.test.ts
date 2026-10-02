import { describe, expect, it } from 'vitest';
import { EditStatus } from '../../../src/domain/change-set';
import type { UserMessage } from '../../../src/domain/conversation';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { EmptySessionExportError, ForeignProjectExportError } from '../../../src/domain/errors';
import { ProjectFileKind, type ProjectFile } from '../../../src/domain/project-file';
import { MAX_SESSION_TITLE_LENGTH, type ConversationSession } from '../../../src/domain/session';
import {
  createSessionExport,
  getSessionExportPath,
  importSessionExport,
  isSessionExportPath,
  listSessionExports,
  type SessionScope,
} from '../../../src/domain/session-export';
import { editWith, proposalOf } from '../../support/proposals';

const owner = { userId: 'user-1', projectId: 'project-1' };
const collaborator = { userId: 'user-2', projectId: 'project-1' };
const first: UserMessage = { id: 'u1', role: 'user', text: 'Add a table' };
const command = createDocumentCommand({
  operation: 'delete',
  target: { lineNumber: 2, lineText: 'x' },
});
const EXPORTED_AT = new Date(2026, 9, 2, 7, 5).getTime();

function sessionTitled(title: string): ConversationSession {
  return { id: 's1', title, createdAt: 10, updatedAt: 20, messages: [first], imported: null };
}

const PATH = 'hans-sessions/2026-10-02-0705-add-a-table.json';
const target = (scope: SessionScope) => ({ path: PATH, scope, id: 'fresh', now: 99 });

const file = (path: string): ProjectFile => ({ id: path, path, kind: ProjectFileKind.Binary });

describe('session export', () => {
  it('carries the session content, the project and the exporting user', () => {
    expect(createSessionExport(sessionTitled('Add a table'), owner, EXPORTED_AT)).toEqual({
      projectId: 'project-1',
      exportedBy: 'user-1',
      exportedAt: EXPORTED_AT,
      session: { title: 'Add a table', createdAt: 10, updatedAt: 20, messages: [first] },
    });
  });

  it('is named by its local export minute and the slug of the title', () => {
    const exported = (title: string) =>
      getSessionExportPath(createSessionExport(sessionTitled(title), owner, EXPORTED_AT));
    expect(exported('Fix the Table: “Results” (v2)!')).toBe(
      'hans-sessions/2026-10-02-0705-fix-the-table-results-v2.json',
    );
    expect(exported('Zażółć gęślą jaźń')).toBe(
      'hans-sessions/2026-10-02-0705-zazolc-gesla-jazn.json',
    );
    expect(exported('???')).toBe('hans-sessions/2026-10-02-0705-session.json');
    expect(exported(`${'word '.repeat(20)}end`)).toBe(
      `hans-sessions/2026-10-02-0705-${'word-'.repeat(7)}word.json`,
    );
  });

  it('is listed only from JSON files directly in the export folder, newest first', () => {
    const files = [
      file('hans-sessions/2026-10-01-0900-a.json'),
      file('main.tex'),
      file('hans-sessions/notes.txt'),
      file('hans-sessions/old/2026-01-01-0000-b.json'),
      file('other/2026-10-03-0000-c.json'),
      file('hans-sessions/2026-10-02-0705-d.json'),
    ];
    expect(listSessionExports(files).map(({ path }) => path)).toEqual([
      'hans-sessions/2026-10-02-0705-d.json',
      'hans-sessions/2026-10-01-0900-a.json',
    ]);
    expect(isSessionExportPath('hans-sessions/x.json')).toBe(true);
    expect(isSessionExportPath('hans-sessions')).toBe(false);
  });
});

describe('session import', () => {
  it('becomes a new session of the importer with a marked title, history and no open edits', () => {
    const proposal = proposalOf('p1', editWith('main.tex', command, EditStatus.Proposed));
    const exported = createSessionExport(
      { ...sessionTitled('Add a table'), messages: [first, proposal] },
      owner,
      EXPORTED_AT,
    );
    expect(importSessionExport(exported, target(collaborator))).toEqual({
      id: 'fresh',
      title: 'Imported: Add a table',
      createdAt: 99,
      updatedAt: 99,
      messages: [first, proposalOf('p1', editWith('main.tex', command, EditStatus.Discarded))],
      imported: { path: PATH, lastMessageId: 'p1' },
    });
  });

  it('keeps the title within the maximum length', () => {
    const long = 'x'.repeat(MAX_SESSION_TITLE_LENGTH);
    const exported = createSessionExport(sessionTitled(long), owner, EXPORTED_AT);
    const { title } = importSessionExport(exported, target(owner));
    expect(title).toHaveLength(MAX_SESSION_TITLE_LENGTH);
    expect(title.startsWith('Imported: xxx')).toBe(true);
  });

  it('is refused in another project', () => {
    const exported = createSessionExport(sessionTitled('Add a table'), owner, EXPORTED_AT);
    expect(() =>
      importSessionExport(exported, target({ ...owner, projectId: 'project-2' })),
    ).toThrow(ForeignProjectExportError);
  });

  it('is refused when the export holds no messages', () => {
    const exported = createSessionExport(
      { ...sessionTitled('Empty'), messages: [] },
      owner,
      EXPORTED_AT,
    );
    expect(() => importSessionExport(exported, target(owner))).toThrow(EmptySessionExportError);
  });
});
