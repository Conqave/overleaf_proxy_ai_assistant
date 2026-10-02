import { describe, expect, it } from 'vitest';
import {
  InvalidProjectTreeError,
  NotATextFileError,
  ProjectFileNotFoundError,
} from '../../../src/domain/errors';
import {
  createProjectFiles,
  findSearchScope,
  findTextFile,
  listTextFiles,
} from '../../../src/domain/project-file';

const files = createProjectFiles([
  { id: 'd1', path: 'main.tex', kind: 'text' },
  { id: 'd2', path: 'chapters/intro.tex', kind: 'text' },
  { id: 'f1', path: 'figures/plot.png', kind: 'binary' },
]);

describe('project files', () => {
  it('finds a text file by its path', () => {
    expect(findTextFile(files, 'chapters/intro.tex').id).toBe('d2');
  });

  it('lists the text files only', () => {
    expect(listTextFiles(files).map((file) => file.path)).toEqual([
      'main.tex',
      'chapters/intro.tex',
    ]);
  });

  it('searches every text file, one file or the text files of one folder', () => {
    const paths = (path?: string) => findSearchScope(files, path).map((file) => file.path);
    expect(paths()).toEqual(['main.tex', 'chapters/intro.tex']);
    expect(paths('main.tex')).toEqual(['main.tex']);
    expect(paths('chapters')).toEqual(['chapters/intro.tex']);
  });

  it('refuses to search an unknown place, a binary file or a folder without text files', () => {
    expect(() => findSearchScope(files, 'chapter')).toThrow(
      new ProjectFileNotFoundError('The project has no file or folder chapter.'),
    );
    expect(() => findSearchScope(files, 'figures/plot.png')).toThrow(NotATextFileError);
    expect(() => findSearchScope(files, 'figures')).toThrow(ProjectFileNotFoundError);
  });

  it('rejects an unknown path and a binary file', () => {
    expect(() => findTextFile(files, 'intro.tex')).toThrow(ProjectFileNotFoundError);
    expect(() => findTextFile(files, 'figures/plot.png')).toThrow(NotATextFileError);
  });

  it.each([
    [
      'a duplicate path',
      [
        { id: 'a', path: 'x.tex', kind: 'text' },
        { id: 'b', path: 'x.tex', kind: 'text' },
      ],
    ],
    [
      'a duplicate id',
      [
        { id: 'a', path: 'x.tex', kind: 'text' },
        { id: 'a', path: 'y.tex', kind: 'text' },
      ],
    ],
    ['an empty id', [{ id: '', path: 'x.tex', kind: 'text' }]],
  ] as const)('rejects a tree with %s', (_name, tree) => {
    expect(() => createProjectFiles(tree)).toThrow(InvalidProjectTreeError);
  });
});
