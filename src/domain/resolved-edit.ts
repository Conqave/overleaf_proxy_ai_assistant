import { isSameDocument, type DocumentSnapshot } from './document';
import { DocumentOperation, type DocumentCommand } from './document-command';
import { resolveTarget } from './document-target';
import { DocumentConflictError, DocumentRangeError } from './errors';
import type { LineSplice } from './file-change';

export class ResolvedEdit {
  private constructor(
    readonly command: DocumentCommand,
    readonly document: DocumentSnapshot,
  ) {}

  static resolve(document: DocumentSnapshot, command: DocumentCommand): ResolvedEdit {
    const target = resolveTarget(document, command.target);
    if (
      command.operation === DocumentOperation.Replace ||
      command.operation === DocumentOperation.Delete
    ) {
      const lastLine = target.lineNumber + command.lineCount - 1;
      if (lastLine > document.lines.length) {
        throw new DocumentRangeError(
          `Lines ${String(target.lineNumber)}–${String(lastLine)} run past the end of the document (${String(document.lines.length)} lines).`,
        );
      }
    }
    return new ResolvedEdit(Object.freeze({ ...command, target }), document);
  }

  get splice(): LineSplice {
    const { command, document } = this;
    const line = command.target.lineNumber;
    switch (command.operation) {
      case DocumentOperation.InsertBefore:
        return { line, removed: [], inserted: command.content.split('\n') };
      case DocumentOperation.InsertAfter:
        return { line: line + 1, removed: [], inserted: command.content.split('\n') };
      case DocumentOperation.Replace:
        return {
          line,
          removed: document.lines.slice(line - 1, line - 1 + command.lineCount),
          inserted: command.content.split('\n'),
        };
      case DocumentOperation.Delete:
        return {
          line,
          removed: document.lines.slice(line - 1, line - 1 + command.lineCount),
          inserted: command.lineCount === document.lines.length ? [''] : [],
        };
    }
  }

  assertCurrent(current: DocumentSnapshot): void {
    if (!isSameDocument(this.document, current)) {
      throw new DocumentConflictError(
        'The document changed after the suggestion was made. Ask again to get a fresh suggestion.',
      );
    }
  }
}
