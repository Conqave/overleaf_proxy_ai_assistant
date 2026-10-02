import { describe, expect, it } from 'vitest';
import { assertBibFieldsSeparated } from '../../../src/domain/bibtex-fields';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { BibFieldSeparatorError } from '../../../src/domain/errors';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';
import { itemAt } from '../../support/guards';

const ENTRY = createDocumentSnapshot([
  '@book{lamport94,',
  '  author = "Leslie Lamport",',
  '  title  = {A long',
  '            title},',
  '  year   = "1994"',
  '}',
]);

const edit = (operation: 'insert_after' | 'replace', lineNumber: number, content: string) =>
  ResolvedEdit.resolve(
    ENTRY,
    createDocumentCommand({
      operation,
      target: { lineNumber, lineText: itemAt(ENTRY.lines, lineNumber - 1, 'line') },
      content,
    }),
  );

describe('assertBibFieldsSeparated', () => {
  it('refuses a field added after a last field that has no comma', () => {
    expect(() => {
      assertBibFieldsSeparated('refs.bib', edit('insert_after', 5, '  isbn = "1",'));
    }).toThrow(BibFieldSeparatorError);
  });

  it('accepts the last field replaced with a comma and the new field', () => {
    expect(() => {
      assertBibFieldsSeparated('refs.bib', edit('replace', 5, '  year   = "1994",\n  isbn = "1"'));
    }).not.toThrow();
  });

  it('accepts a field added with a comma after the first line and multi-line values', () => {
    expect(() => {
      assertBibFieldsSeparated('refs.bib', edit('insert_after', 1, '  isbn = "1",'));
    }).not.toThrow();
  });

  it('leaves files other than .bib files alone', () => {
    expect(() => {
      assertBibFieldsSeparated('notes.tex', edit('insert_after', 5, '  isbn = "1",'));
    }).not.toThrow();
  });
});
