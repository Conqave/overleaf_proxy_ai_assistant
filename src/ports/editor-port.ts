import type { DocumentSnapshot } from '../domain/document';
import type { TextFile } from '../domain/project-file';
import type { ResolvedEdit } from '../domain/resolved-edit';

export interface EditorPort {
  readDocument(file: TextFile): DocumentSnapshot;
  readSelection(file: TextFile): string;
  readCursorLine(file: TextFile): number;
  showPreview(file: TextFile, edit: ResolvedEdit): void;
  clearPreview(): void;
  apply(file: TextFile, edit: ResolvedEdit): void;
}
