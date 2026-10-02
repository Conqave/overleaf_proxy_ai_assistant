import {
  InvalidProjectPathError,
  InvalidProjectTreeError,
  NotATextFileError,
  ProjectFileNotFoundError,
} from './errors';

export const ProjectFileKind = {
  Text: 'text',
  Binary: 'binary',
} as const;
export type ProjectFileKind = (typeof ProjectFileKind)[keyof typeof ProjectFileKind];

interface ProjectEntry {
  readonly id: string;
  readonly path: string;
}

export interface TextFile extends ProjectEntry {
  readonly kind: typeof ProjectFileKind.Text;
}

export interface BinaryFile extends ProjectEntry {
  readonly kind: typeof ProjectFileKind.Binary;
}

export type ProjectFile = TextFile | BinaryFile;

export const PATH_SEPARATOR = '/';

const RELATIVE_SEGMENTS: readonly string[] = ['.', '..'];

export function createProjectPath(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidProjectPathError('a path must be a string');
  if (/[\r\n]/.test(value)) {
    throw new InvalidProjectPathError(`path ${JSON.stringify(value)} must be a single line`);
  }
  const segments = value.split(PATH_SEPARATOR);
  const broken = segments.find(
    (segment) => segment.trim() === '' || RELATIVE_SEGMENTS.includes(segment),
  );
  if (broken !== undefined) {
    throw new InvalidProjectPathError(
      `path ${JSON.stringify(value)} must be relative to the project root, without empty, "." or ".." parts`,
    );
  }
  return value;
}

export function createProjectFiles(files: readonly ProjectFile[]): readonly ProjectFile[] {
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const file of files) {
    createProjectPath(file.path);
    if (file.id === '') throw new InvalidProjectTreeError(`${file.path} has an empty id`);
    if (paths.has(file.path)) throw new InvalidProjectTreeError(`${file.path} is listed twice`);
    if (ids.has(file.id)) throw new InvalidProjectTreeError(`id ${file.id} is listed twice`);
    paths.add(file.path);
    ids.add(file.id);
  }
  return Object.freeze(files.map((file) => Object.freeze({ ...file })));
}

export function findTextFile(files: readonly ProjectFile[], path: string): TextFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new ProjectFileNotFoundError(`The project has no file ${path}.`);
  }
  if (file.kind !== ProjectFileKind.Text) {
    throw new NotATextFileError(`${path} is not a text file.`);
  }
  return file;
}

export function findSearchScope(
  files: readonly ProjectFile[],
  path: string | undefined,
): readonly TextFile[] {
  const texts = listTextFiles(files);
  if (path === undefined) return texts;
  const scope = texts.filter((file) => isInScope(file.path, path));
  if (scope.length) return scope;
  if (files.some((file) => file.path === path)) {
    throw new NotATextFileError(`${path} is not a text file.`);
  }
  throw new ProjectFileNotFoundError(`The project has no file or folder ${path}.`);
}

export function isInScope(path: string, scope: string | undefined): boolean {
  return scope === undefined || path === scope || path.startsWith(`${scope}${PATH_SEPARATOR}`);
}

export function listTextFiles(files: readonly ProjectFile[]): readonly TextFile[] {
  return files.filter((file) => file.kind === ProjectFileKind.Text);
}
