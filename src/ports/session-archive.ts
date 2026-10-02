import type { ProjectFile } from '../domain/project-file';
import type { SessionExport } from '../domain/session-export';
import type { CancellationSignal } from './cancellation';

export interface SessionArchive {
  save(path: string, exported: SessionExport, signal: CancellationSignal): Promise<void>;
  load(file: ProjectFile, signal: CancellationSignal): Promise<SessionExport>;
}
