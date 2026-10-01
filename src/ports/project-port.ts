import type { CompileDiagnostic } from '../domain/agent-transcript';
import type { DocumentSnapshot } from '../domain/document';
import type { ProjectFile, TextFile } from '../domain/project-file';
import type { CancellationSignal } from './cancellation';

export interface ProjectPort {
  listFiles(): readonly ProjectFile[];
  openFilePath(): string;
  readFile(file: TextFile, signal: CancellationSignal): Promise<DocumentSnapshot>;
  openFile(file: TextFile, signal: CancellationSignal): Promise<void>;
  compile(signal: CancellationSignal): Promise<readonly CompileDiagnostic[]>;
}
