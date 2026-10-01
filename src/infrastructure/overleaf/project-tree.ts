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
  const files: ProjectFile[] = [];
  const folderIds = new Map<string, readonly string[]>();
  collectFolder(readFolder(rootFolder[0]), [], [], files, folderIds);
  return { files: validateFiles(files), folderIds };
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
  files: ProjectFile[],
  folderIds: Map<string, readonly string[]>,
): void {
  const add = (value: unknown, kind: ProjectFileKind): void => {
    const { id, name } = readEntity(value);
    files.push({ id, path: [...names, name].join(PATH_SEPARATOR), kind });
    folderIds.set(id, ancestors);
  };
  for (const doc of folder.docs) add(doc, ProjectFileKind.Text);
  for (const fileRef of folder.fileRefs) add(fileRef, ProjectFileKind.Binary);
  for (const value of folder.folders) {
    const child = readFolder(value);
    collectFolder(child, [...names, child.name], [...ancestors, child.id], files, folderIds);
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
