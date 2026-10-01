import type { CompileDiagnostic } from '../domain/agent-transcript';
import type { DocumentSnapshot } from '../domain/document';
import type { ProjectFile, TextFile } from '../domain/project-file';

export interface ProjectPort {
  listFiles(): readonly ProjectFile[];
  openFilePath(): string;
  readFile(file: TextFile): Promise<DocumentSnapshot>;
  openFile(file: TextFile): Promise<void>;
  compile(): Promise<readonly CompileDiagnostic[]>;
}
