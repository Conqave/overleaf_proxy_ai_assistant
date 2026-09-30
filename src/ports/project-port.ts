import type { CompileDiagnostic } from '../domain/agent-transcript';
import type { DocumentSnapshot } from '../domain/document';
import type { ProjectFile } from '../domain/project-file';

export interface ProjectPort {
  listFiles(): readonly ProjectFile[];
  openFilePath(): string;
  readFile(file: ProjectFile): Promise<DocumentSnapshot>;
  openFile(file: ProjectFile): Promise<void>;
  compile(): Promise<readonly CompileDiagnostic[]>;
}
