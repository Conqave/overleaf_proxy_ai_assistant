import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { DocumentRangeError, DocumentTargetNotFoundError } from '../../../src/domain/errors';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';

const target = { lineNumber: 2, lineText: '\\section{Introduction}' };

describe('ResolvedEdit.resolve', () => {
  const snapshot = createDocumentSnapshot(['a', '\\section{Introduction}', 'b', 'c']);

  it('keeps a range that lies within the document', () => {
    const exact = { lineNumber: 2, lineText: '\\section{Introduction}' };
    const command = createDocumentCommand({ operation: 'delete', target: exact, lineCount: 2 });
    expect(ResolvedEdit.resolve(snapshot, command).command).toMatchObject({
      target: { lineNumber: 2 },
      lineCount: 2,
    });
  });

  it('never moves a range to another line with the same text', () => {
    const shifted = { lineNumber: 1, lineText: '\\section{Introduction}' };
    const command = createDocumentCommand({ operation: 'delete', target: shifted, lineCount: 2 });
    expect(() => ResolvedEdit.resolve(snapshot, command)).toThrow(DocumentTargetNotFoundError);
  });

  it('rejects a range that runs past the end of the document', () => {
    const command = createDocumentCommand({ operation: 'delete', target, lineCount: 4 });
    expect(() => ResolvedEdit.resolve(snapshot, command)).toThrow(DocumentRangeError);
  });

  it('keeps the document it was resolved against', () => {
    const command = createDocumentCommand({ operation: 'delete', target, lineCount: 1 });
    expect(ResolvedEdit.resolve(snapshot, command).document).toBe(snapshot);
  });

  it('rejects a target that is not in the document', () => {
    const missing = { lineNumber: 1, lineText: 'nowhere' };
    const command = createDocumentCommand({ operation: 'delete', target: missing, lineCount: 1 });
    expect(() => ResolvedEdit.resolve(snapshot, command)).toThrow(DocumentTargetNotFoundError);
  });
});
