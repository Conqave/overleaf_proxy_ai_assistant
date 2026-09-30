import { describe, expect, it } from 'vitest';
import {
  InvalidProjectTreeError,
  NotATextFileError,
  ProjectFileNotFoundError,
} from '../../../src/domain/errors';
import { createProjectFiles, findTextFile } from '../../../src/domain/project-file';

const files = createProjectFiles([
  { id: 'd1', path: 'main.tex', kind: 'text' },
  { id: 'd2', path: 'chapters/intro.tex', kind: 'text' },
  { id: 'f1', path: 'figures/plot.png', kind: 'binary' },
]);

describe('project files', () => {
  it('finds a text file by its path', () => {
    expect(findTextFile(files, 'chapters/intro.tex').id).toBe('d2');
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
