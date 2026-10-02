import { InvalidProjectPathError, InvalidProjectTreeError } from '../../domain/errors';
import {
  createProjectFiles,
  PATH_SEPARATOR,
  ProjectFileKind,
  type ProjectFile,
} from '../../domain/project-file';
import { OverleafStoreContractError } from './overleaf-store';

export interface ProjectTree {
  readonly files: readonly ProjectFile[];
  readonly folderIds: ReadonlyMap<string, readonly string[]>;
  readonly rootFolderId: string;
  readonly folders: ReadonlyMap<string, string>;
}

interface TreeListing {
  readonly files: ProjectFile[];
  readonly folderIds: Map<string, readonly string[]>;
  readonly folders: Map<string, string>;
}

interface Entity {
  readonly id: string;
  readonly name: string;
}

interface Folder extends Entity {
  readonly folders: readonly unknown[];
  readonly docs: readonly unknown[];
  readonly fileRefs: readonly unknown[];
}

export function readProjectTree(project: unknown): ProjectTree {
  if (typeof project !== 'object' || project === null || !('rootFolder' in project)) {
    throw new OverleafStoreContractError('project has no rootFolder');
  }
  const { rootFolder } = project;
  if (!Array.isArray(rootFolder) || rootFolder.length !== 1) {
    throw new OverleafStoreContractError('project.rootFolder is not a list of one folder');
  }
  const root = readFolder(rootFolder[0]);
  const listing: TreeListing = { files: [], folderIds: new Map(), folders: new Map() };
  collectFolder(root, [], [], listing);
  return {
    files: validateFiles(listing.files),
    folderIds: listing.folderIds,
    rootFolderId: root.id,
    folders: listing.folders,
  };
}

function validateFiles(files: readonly ProjectFile[]): readonly ProjectFile[] {
  try {
    return createProjectFiles(files);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError || error instanceof InvalidProjectTreeError)) {
      throw error;
    }
    throw new OverleafStoreContractError(`the project tree is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

function collectFolder(
  folder: Folder,
  names: readonly string[],
  ancestors: readonly string[],
  listing: TreeListing,
): void {
  const { files, folderIds, folders } = listing;
  const entry = (value: unknown): { id: string; path: string } => {
    const { id, name } = readEntity(value);
    folderIds.set(id, ancestors);
    return { id, path: [...names, name].join(PATH_SEPARATOR) };
  };
  for (const doc of folder.docs) files.push({ ...entry(doc), kind: ProjectFileKind.Text });
  for (const fileRef of folder.fileRefs) {
    files.push({ ...entry(fileRef), kind: ProjectFileKind.Binary });
  }
  for (const value of folder.folders) {
    const child = readFolder(value);
    const path = [...names, child.name];
    folders.set(path.join(PATH_SEPARATOR), child.id);
    collectFolder(child, path, [...ancestors, child.id], listing);
  }
}

function readFolder(value: unknown): Folder {
  const { id, name } = readEntity(value);
  if (
    !(typeof value === 'object' && value !== null) ||
    !('folders' in value && Array.isArray(value.folders)) ||
    !('docs' in value && Array.isArray(value.docs)) ||
    !('fileRefs' in value && Array.isArray(value.fileRefs))
  ) {
    throw new OverleafStoreContractError(`folder ${name} lacks folders, docs or fileRefs lists`);
  }
  return { id, name, folders: value.folders, docs: value.docs, fileRefs: value.fileRefs };
}

function readEntity(value: unknown): Entity {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('_id' in value && typeof value._id === 'string') ||
    !('name' in value && typeof value.name === 'string')
  ) {
    throw new OverleafStoreContractError('a file tree entry has no string _id and name');
  }
  return { id: value._id, name: value.name };
}
