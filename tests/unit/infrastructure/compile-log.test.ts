import { describe, expect, it } from 'vitest';
import { readCompileDiagnostics } from '../../../src/infrastructure/overleaf/compile-log';
import { OverleafStoreContractError } from '../../../src/infrastructure/overleaf/overleaf-store';

const entries = (groups: Record<string, unknown>): unknown => ({
  errors: [],
  warnings: [],
  typesetting: [],
  all: [],
  ...groups,
});

describe('readCompileDiagnostics', () => {
  it('maps LaTeX log entries to diagnostics at project paths', () => {
    const logEntries = entries({
      errors: [
        { level: 'error', message: 'Undefined control sequence.', file: './main.tex', line: 20 },
      ],
      warnings: [
        {
          level: 'warning',
          message: 'There were undefined references.',
          file: './main.tex',
          line: null,
        },
      ],
      typesetting: [
        { level: 'typesetting', message: 'Overfull \\hbox', file: './chapters/intro.tex', line: 3 },
      ],
    });
    expect(readCompileDiagnostics(logEntries)).toEqual([
      { level: 'error', message: 'Undefined control sequence.', path: 'main.tex', lineNumber: 20 },
      { level: 'warning', message: 'There were undefined references.', path: 'main.tex' },
      {
        level: 'typesetting',
        message: 'Overfull \\hbox',
        path: 'chapters/intro.tex',
        lineNumber: 3,
      },
    ]);
  });

  it('reads BibTeX entries whose line is text and whose file may be unknown', () => {
    const logEntries = entries({
      warnings: [
        { level: 'warning', message: 'empty year in knuth84', file: 'refs.bib', line: '12' },
        { level: 'warning', message: 'I found no \\citation commands', file: '', line: '' },
      ],
    });
    expect(readCompileDiagnostics(logEntries)).toEqual([
      { level: 'warning', message: 'empty year in knuth84', path: 'refs.bib', lineNumber: 12 },
      { level: 'warning', message: 'I found no \\citation commands' },
    ]);
  });

  it('leaves out the location of an entry outside the project', () => {
    const logEntries = entries({
      warnings: [
        { message: 'Font shape undefined', file: '/usr/share/texlive/article.cls', line: 5 },
      ],
    });
    expect(readCompileDiagnostics(logEntries)).toEqual([
      { level: 'warning', message: 'Font shape undefined', lineNumber: 5 },
    ]);
  });

  it.each([
    ['no entries', null],
    ['a group that is not a list', entries({ errors: 'none' })],
    ['an entry without message', entries({ errors: [{ file: './main.tex', line: 1 }] })],
    ['a line that is no number', entries({ errors: [{ message: 'x', line: 'twelve' }] })],
    ['a file that is no project path', entries({ errors: [{ message: 'x', file: '../up.tex' }] })],
  ])('rejects %s as a broken store contract', (_, logEntries) => {
    expect(() => readCompileDiagnostics(logEntries)).toThrow(OverleafStoreContractError);
  });
});
