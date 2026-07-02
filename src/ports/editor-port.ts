import type { DocumentSnapshot } from '../domain/document';
import type { ResolvedEdit } from '../domain/resolved-edit';

export interface EditorPort {
  readDocument(): DocumentSnapshot;
  readSelection(): string;
  readCursorLine(): number;
  readCompileLogs(): string;
  showPreview(edit: ResolvedEdit): void;
  clearPreview(): void;
  apply(edit: ResolvedEdit): void;
}
