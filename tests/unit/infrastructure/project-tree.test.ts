import { describe, expect, it } from 'vitest';
import { InvalidProjectPathError, InvalidProjectTreeError } from '../../../src/domain/errors';
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

  it('names the root folder and every folder by its path', () => {
    const { rootFolderId, folders } = readProjectTree({ rootFolder: [FIXTURE_ROOT_FOLDER] });
    expect(rootFolderId).toBe('folder-root');
    expect([...folders]).toEqual([
      ['chapters', 'folder-chapters'],
      ['chapters/intro', 'folder-intro'],
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

  it.each([
    ['two files at one path', { _id: 'doc-other', name: 'main.tex' }, InvalidProjectTreeError],
    ['a file with a blank name', { _id: 'doc-blank', name: ' ' }, InvalidProjectPathError],
  ])('rejects a tree with %s as a broken store contract', (_, doc, domainError) => {
    const root = { ...FIXTURE_ROOT_FOLDER, docs: [...FIXTURE_ROOT_FOLDER.docs, doc] };
    let cause: unknown;
    try {
      readProjectTree({ rootFolder: [root] });
    } catch (error) {
      if (!(error instanceof OverleafStoreContractError)) throw error;
      cause = error.cause;
    }
    expect(cause).toBeInstanceOf(domainError);
  });
});
