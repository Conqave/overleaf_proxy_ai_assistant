import { ProjectFileNotFoundError } from '../domain/errors';
import type { ProjectFile } from '../domain/project-file';
import {
  createSessionExport,
  getSessionExportPath,
  importSessionExport,
  listSessionExports,
} from '../domain/session-export';
import type { SessionScope } from '../domain/session';
import type { ProjectPort } from '../ports/project-port';
import type { SessionArchive } from '../ports/session-archive';
import { leaveCurrentSession, type SessionDeps } from './conversation-session';
import { ensureNotCancelled } from './operation-lock';

interface SessionExchangeDeps extends SessionDeps {
  readonly archive: SessionArchive;
  readonly project: Pick<ProjectPort, 'listFiles'>;
  readonly scope: SessionScope;
  readonly newId: () => string;
  readonly now: () => number;
}

export class ExportSession {
  constructor(
    private readonly deps: Pick<
      SessionExchangeDeps,
      'sessions' | 'archive' | 'project' | 'scope' | 'lock' | 'now'
    >,
  ) {}

  execute(id: string): Promise<string> {
    const { sessions, archive, project, scope, lock, now } = this.deps;
    return lock.run(async (signal) => {
      const session = await sessions.load(id);
      const exported = createSessionExport(session, scope, now());
      const path = getSessionExportPath(exported, project.listFiles());
      await archive.save(path, exported, signal);
      return path;
    });
  }
}

export class ListSessionExports {
  constructor(private readonly deps: Pick<SessionExchangeDeps, 'project'>) {}

  execute(): readonly string[] {
    return listSessionExports(this.deps.project.listFiles()).map(({ path }) => path);
  }
}

export class ImportSession {
  constructor(private readonly deps: SessionExchangeDeps) {}

  execute(path: string): Promise<void> {
    const { sessions, archive, project, scope, conversation, lock, newId, now } = this.deps;
    return lock.run(async (signal) => {
      const exported = await archive.load(findExport(project.listFiles(), path), signal);
      const session = importSessionExport(exported, { path, scope, id: newId(), now: now() });
      await sessions.save(session);
      ensureNotCancelled(signal);
      leaveCurrentSession(this.deps);
      conversation.show(session);
    });
  }
}

function findExport(files: readonly ProjectFile[], path: string): ProjectFile {
  const file = listSessionExports(files).find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new ProjectFileNotFoundError(
      `The project has no session export ${path}; reload Overleaf to see the current files.`,
    );
  }
  return file;
}
