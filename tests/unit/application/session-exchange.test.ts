import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationLog } from '../../../src/application/conversation-log';
import { RequestInProgressError } from '../../../src/application/errors';
import { OperationLock } from '../../../src/application/operation-lock';
import { PendingChanges } from '../../../src/application/pending-change';
import {
  ExportSession,
  ImportSession,
  ListSessionExports,
} from '../../../src/application/session-exchange';
import { EditStatus } from '../../../src/domain/change-set';
import type { ConversationMessage } from '../../../src/domain/conversation';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { ForeignProjectExportError, ProjectFileNotFoundError } from '../../../src/domain/errors';
import type { SessionScope } from '../../../src/domain/session-export';
import { SessionNotFoundError, UnreadableSessionExportError } from '../../../src/ports/errors';
import {
  FakeEditor,
  FakeProject,
  InMemorySessionArchive,
  InMemorySessionRepository,
  sequentialIds,
  storedSession,
} from '../../support/fakes';
import { editWith, proposalOf } from '../../support/proposals';

const OWNER: SessionScope = { userId: 'owner', projectId: 'project-1' };
const COLLABORATOR: SessionScope = { userId: 'collaborator', projectId: 'project-1' };
const EXPORTED_AT = new Date(2026, 9, 2, 7, 5).getTime();
const EXPORT_PATH = 'hans-sessions/2026-10-02-0705-session-shared.json';

const command = createDocumentCommand({
  operation: 'delete',
  target: { lineNumber: 1, lineText: 'Hello.' },
});
const sharedMessages: ConversationMessage[] = [
  { id: 'u1', role: 'user', text: 'Tidy the intro' },
  proposalOf('p1', editWith('main.tex', command, EditStatus.Applied)),
  { id: 'u2', role: 'user', text: 'And the outro' },
  proposalOf('p2', editWith('main.tex', command, EditStatus.Proposed)),
];

interface Workspace {
  readonly repository: InMemorySessionRepository;
  readonly conversation: ConversationLog;
  readonly lock: OperationLock;
  readonly busy: boolean[];
  readonly project: FakeProject;
  exportSession(id: string): Promise<string>;
  listExports(): readonly string[];
  importSession(path: string): Promise<void>;
}

let archive: InMemorySessionArchive;

function openWorkspace(scope: SessionScope, exportPaths: readonly string[] = []): Workspace {
  const editor = new FakeEditor([]);
  const project = new FakeProject(editor, { 'main.tex': ['Hello.'] }, 'main.tex', exportPaths);
  const repository = new InMemorySessionRepository();
  const conversation = new ConversationLog({
    sessions: repository,
    newId: sequentialIds('session'),
    now: () => 1,
  });
  const lock = new OperationLock(() => new AbortController());
  const busy: boolean[] = [];
  lock.onChange((isBusy) => {
    busy.push(isBusy);
  });
  const deps = {
    sessions: repository,
    conversation,
    pendingChanges: new PendingChanges(conversation),
    editor,
    lock,
    archive,
    project,
    scope,
    newId: sequentialIds('imported'),
    now: () => EXPORTED_AT,
  };
  return {
    repository,
    conversation,
    lock,
    busy,
    project,
    exportSession: (id) => new ExportSession(deps).execute(id),
    listExports: () => new ListSessionExports(deps).execute(),
    importSession: (path) => new ImportSession(deps).execute(path),
  };
}

beforeEach(() => {
  archive = new InMemorySessionArchive();
});

describe('ExportSession', () => {
  it('writes the saved session into the project under a dated name, inside the lock', async () => {
    const owner = openWorkspace(OWNER);
    owner.repository.stored.set('shared', storedSession('shared', sharedMessages, 7));
    await expect(owner.exportSession('shared')).resolves.toBe(EXPORT_PATH);
    expect(owner.busy).toEqual([true, false]);
    expect(archive.signals).toHaveLength(1);
    expect(archive.saved.get(EXPORT_PATH)).toEqual({
      projectId: 'project-1',
      exportedBy: 'owner',
      exportedAt: EXPORTED_AT,
      session: { title: 'Session shared', createdAt: 0, updatedAt: 7, messages: sharedMessages },
    });
  });

  it('writes nothing for a session that is gone and waits for a running operation', async () => {
    const owner = openWorkspace(OWNER);
    await expect(owner.exportSession('gone')).rejects.toThrow(SessionNotFoundError);
    void owner.lock.run(() => new Promise<void>(() => undefined));
    await expect(owner.exportSession('gone')).rejects.toThrow(RequestInProgressError);
    expect(archive.saved.size).toBe(0);
  });
});

describe('ListSessionExports', () => {
  it('lists the session exports of the project tree, newest first', () => {
    const workspace = openWorkspace(COLLABORATOR, [
      'hans-sessions/2026-10-01-0900-older.json',
      'hans-sessions/notes.txt',
      'figures/plot.json',
      EXPORT_PATH,
    ]);
    expect(workspace.listExports()).toEqual([
      EXPORT_PATH,
      'hans-sessions/2026-10-01-0900-older.json',
    ]);
  });
});

describe('ImportSession', () => {
  async function exportShared(): Promise<void> {
    const owner = openWorkspace(OWNER);
    owner.repository.stored.set('shared', storedSession('shared', sharedMessages, 7));
    await owner.exportSession('shared');
  }

  it('lets a collaborator continue the exported session as a new session of their own', async () => {
    await exportShared();
    const collaborator = openWorkspace(COLLABORATOR, [EXPORT_PATH]);
    collaborator.repository.stored.set('mine', storedSession('mine', sharedMessages.slice(0, 1)));
    await collaborator.importSession(EXPORT_PATH);
    const imported = collaborator.repository.stored.get('imported-1');
    expect(imported).toEqual({
      id: 'imported-1',
      title: 'Imported: Session shared',
      createdAt: EXPORTED_AT,
      updatedAt: EXPORTED_AT,
      messages: [
        sharedMessages[0],
        proposalOf('p1', editWith('main.tex', command, EditStatus.AppliedBeforeImport)),
        sharedMessages[2],
        proposalOf('p2', editWith('main.tex', command, EditStatus.Discarded)),
      ],
      imported: { path: EXPORT_PATH, lastMessageId: 'p2' },
    });
    expect(collaborator.conversation.sessionId).toBe('imported-1');
    expect(collaborator.conversation.messages()).toEqual(imported?.messages);
    expect(collaborator.repository.stored.has('mine')).toBe(true);
    expect(collaborator.busy).toEqual([true, false]);
    expect(archive.saved.get(EXPORT_PATH)?.session.messages).toEqual(sharedMessages);
  });

  it('refuses an export of another project and keeps the conversation', async () => {
    await exportShared();
    const elsewhere = openWorkspace({ ...COLLABORATOR, projectId: 'project-2' }, [EXPORT_PATH]);
    await expect(elsewhere.importSession(EXPORT_PATH)).rejects.toThrow(ForeignProjectExportError);
    expect(elsewhere.repository.stored.size).toBe(0);
    expect(elsewhere.conversation.sessionId).toBeNull();
  });

  it('refuses a path that the project tree does not list as an export', async () => {
    await exportShared();
    const collaborator = openWorkspace(COLLABORATOR, []);
    await expect(collaborator.importSession(EXPORT_PATH)).rejects.toThrow(ProjectFileNotFoundError);
    const misplaced = openWorkspace(COLLABORATOR, ['main.json']);
    await expect(misplaced.importSession('main.json')).rejects.toThrow(ProjectFileNotFoundError);
  });

  it('stores nothing when the export cannot be read', async () => {
    const collaborator = openWorkspace(COLLABORATOR, [EXPORT_PATH]);
    archive.failure = new UnreadableSessionExportError('corrupt');
    await expect(collaborator.importSession(EXPORT_PATH)).rejects.toThrow(
      UnreadableSessionExportError,
    );
    expect(collaborator.repository.stored.size).toBe(0);
    expect(collaborator.conversation.sessionId).toBeNull();
  });
});
