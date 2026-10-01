import { describe, expect, it } from 'vitest';
import { InvalidProjectTreeError } from '../../../src/domain/errors';
import { OverleafStoreContractError } from '../../../src/infrastructure/overleaf/overleaf-store';
import { readProjectTree } from '../../../src/infrastructure/overleaf/project-tree';
import { FIXTURE_ROOT_FOLDER } from '../../support/fake-overleaf';

describe('readProjectTree', () => {
  it('lists docs as text and uploaded files as binary, by path below the root folder', () => {
    const tree = readProjectTree({ rootFolder: [FIXTURE_ROOT_FOLDER] });
    expect(tree.files).toEqual([
      { id: 'doc-main', path: 'main.tex', kind: 'text' },
      { id: 'doc-refs', path: 'refs.bib', kind: 'text' },
      { id: 'file-frog', path: 'frog.jpg', kind: 'binary' },
      { id: 'doc-intro', path: 'chapters/intro/intro.tex', kind: 'text' },
    ]);
  });

  it('knows the folders to expand before a file is visible', () => {
    const { folderIds } = readProjectTree({ rootFolder: [FIXTURE_ROOT_FOLDER] });
    expect(folderIds.get('doc-main')).toEqual([]);
    expect(folderIds.get('doc-intro')).toEqual(['folder-chapters', 'folder-intro']);
  });

  it.each([
    ['no project', undefined],
    ['no root folder', {}],
    ['two root folders', { rootFolder: [FIXTURE_ROOT_FOLDER, FIXTURE_ROOT_FOLDER] }],
    ['a folder without docs', { rootFolder: [{ ...FIXTURE_ROOT_FOLDER, docs: undefined }] }],
    [
      'an entry without id',
      { rootFolder: [{ ...FIXTURE_ROOT_FOLDER, docs: [{ name: 'a.tex' }] }] },
    ],
  ])('rejects %s as a broken store contract', (_, project) => {
    expect(() => readProjectTree(project)).toThrow(OverleafStoreContractError);
  });

  it('rejects a tree with two files at one path', () => {
    const twice = { _id: 'doc-other', name: 'main.tex' };
    const root = { ...FIXTURE_ROOT_FOLDER, docs: [...FIXTURE_ROOT_FOLDER.docs, twice] };
    expect(() => readProjectTree({ rootFolder: [root] })).toThrow(InvalidProjectTreeError);
  });
});
