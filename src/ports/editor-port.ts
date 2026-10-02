import type { DocumentSnapshot } from '../domain/document';
import type { FileChange } from '../domain/file-change';
import type { TextFile } from '../domain/project-file';
import type { ResolvedEdit } from '../domain/resolved-edit';

export interface EditorPort {
  readDocument(file: TextFile): DocumentSnapshot;
  readSelection(file: TextFile): string;
  readCursorLine(file: TextFile): number;
  showPreview(file: TextFile, edits: readonly ResolvedEdit[]): void;
  clearPreview(): void;
  apply(file: TextFile, change: FileChange): void;
}
