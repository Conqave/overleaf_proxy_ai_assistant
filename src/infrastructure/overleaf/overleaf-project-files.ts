import { InvariantViolation, NamedError } from '../../domain/errors';
import {
  createProjectPath,
  PATH_SEPARATOR,
  ProjectFileKind,
  type ProjectFile,
} from '../../domain/project-file';
import type { CancellationSignal } from '../../ports/cancellation';
import {
  ProjectFileReadError,
  ProjectFileReadTimeoutError,
  ProjectFileWriteError,
  ProjectFileWriteTimeoutError,
  ProjectTreeOutdatedError,
  ProjectUnavailableError,
} from '../../ports/errors';
import { withDeadline } from '../deadline';
import { formatDuration } from '../duration';
import { StoreKey, type OverleafStore } from './overleaf-store';
import { readProjectTree, type ProjectTree } from './project-tree';

const FILE_READ_MS = 20_000;
const FILE_WRITE_MS = 20_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const ENTITY_EXISTS = 'File already exists';

interface OverleafProjectFilesDependencies {
  readonly store: OverleafStore;
  readonly fetch: typeof fetch;
  readonly projectId: string;
  readonly csrfToken: string;
}

export class OverleafFileApiContractError extends NamedError {
  constructor(request: string, problem: string) {
    super(`Overleaf's answer to ${request} does not match the expected contract: ${problem}.`);
  }
}

export class OverleafProjectFiles {
  private readonly createdFolders = new Map<string, string>();

  constructor(private readonly deps: OverleafProjectFilesDependencies) {}

  read(file: ProjectFile, cancel: CancellationSignal): Promise<string> {
    return withDeadline(
      FILE_READ_MS,
      () =>
        new ProjectFileReadTimeoutError(
          `${file.path} could not be read within ${formatDuration(FILE_READ_MS)}.`,
        ),
      [cancel],
      (signal) => this.download(file, signal),
    );
  }

  write(path: string, text: string, cancel: CancellationSignal): Promise<void> {
    const segments = createProjectPath(path).split(PATH_SEPARATOR);
    const name = segments.pop();
    if (name === undefined) throw new InvariantViolation(`${path} names no file`);
    return withDeadline(
      FILE_WRITE_MS,
      () =>
        new ProjectFileWriteTimeoutError(
          `${path} could not be written within ${formatDuration(FILE_WRITE_MS)}.`,
        ),
      [cancel],
      async (signal) => {
        const folderId = await this.ensureFolder(segments, signal);
        await this.upload(folderId, name, text, path, signal);
      },
    );
  }

  private async download(file: ProjectFile, signal: AbortSignal): Promise<string> {
    const response = await this.request(this.downloadUrl(file), {}, `read ${file.path}`, signal);
    if (response.status === HTTP_NOT_FOUND) {
      throw new ProjectTreeOutdatedError(
        `${file.path} was moved or deleted after the page loaded; reload Overleaf to see the current files.`,
      );
    }
    if (!response.ok) {
      throw new ProjectFileReadError(
        `${file.path} could not be read: Overleaf answered HTTP ${String(response.status)}.`,
      );
    }
    return await this.readBody(response, `The download of ${file.path} was interrupted.`, signal);
  }

  private downloadUrl(file: ProjectFile): string {
    const { projectId } = this.deps;
    switch (file.kind) {
      case ProjectFileKind.Text:
        return `/Project/${projectId}/doc/${file.id}/download`;
      case ProjectFileKind.Binary:
        return `/project/${projectId}/file/${file.id}`;
    }
  }

  private async ensureFolder(names: readonly string[], signal: AbortSignal): Promise<string> {
    const tree = readProjectTree(this.deps.store.get(StoreKey.Project));
    let folderId = tree.rootFolderId;
    for (const [depth, name] of names.entries()) {
      const path = names.slice(0, depth + 1).join(PATH_SEPARATOR);
      const known = this.findFolder(tree, path);
      folderId = known ?? (await this.createFolder(path, name, folderId, signal));
    }
    return folderId;
  }

  private findFolder(tree: ProjectTree, path: string): string | undefined {
    const listed = tree.folders.get(path);
    if (listed === undefined) return this.createdFolders.get(path);
    this.createdFolders.delete(path);
    return listed;
  }

  private async createFolder(
    path: string,
    name: string,
    parentId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      `/project/${this.deps.projectId}/folder`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': this.deps.csrfToken },
        body: JSON.stringify({ name, parent_folder_id: parentId }),
      },
      `create the folder ${path}`,
      signal,
    );
    const body = await this.readBody(
      response,
      `Creating the folder ${path} was interrupted.`,
      signal,
    );
    if (response.status === HTTP_BAD_REQUEST && body === ENTITY_EXISTS) {
      throw new ProjectTreeOutdatedError(
        `${path} was added to the project after the page loaded; reload Overleaf and try again.`,
      );
    }
    if (!response.ok) {
      throw new ProjectFileWriteError(
        `The folder ${path} could not be created: Overleaf answered HTTP ${String(response.status)}.`,
      );
    }
    const id = readFolderId(parseJson(body, 'folder creation'));
    this.createdFolders.set(path, id);
    return id;
  }

  private async upload(
    folderId: string,
    name: string,
    text: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const form = new FormData();
    form.append('name', name);
    form.append('qqfile', new Blob([text]), name);
    const response = await this.request(
      `/project/${this.deps.projectId}/upload?folder_id=${encodeURIComponent(folderId)}`,
      { method: 'POST', headers: { 'X-Csrf-Token': this.deps.csrfToken }, body: form },
      `write ${path}`,
      signal,
    );
    const body = await this.readBody(response, `Writing ${path} was interrupted.`, signal);
    if (response.status === HTTP_NOT_FOUND) {
      this.createdFolders.clear();
      throw new ProjectTreeOutdatedError(
        `The folder of ${path} was moved or deleted; try again to create it anew.`,
      );
    }
    if (!response.ok) {
      throw new ProjectFileWriteError(
        `${path} could not be written: Overleaf answered HTTP ${String(response.status)}.`,
      );
    }
    if (!isUploadSuccess(parseJson(body, 'upload'))) {
      throw new ProjectFileWriteError(`${path} could not be written: Overleaf refused the upload.`);
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    action: string,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.deps.fetch(url, { ...init, cache: 'no-store', signal });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectUnavailableError(`Overleaf could not be reached to ${action}.`, {
        cause: error,
      });
    }
  }

  private async readBody(
    response: Response,
    interrupted: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectUnavailableError(interrupted, { cause: error });
    }
  }
}

function parseJson(text: string, request: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new OverleafFileApiContractError(request, 'the body is not JSON');
  }
}

function readFolderId(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('_id' in value && typeof value._id === 'string' && value._id !== '')
  ) {
    throw new OverleafFileApiContractError('folder creation', 'it names no folder _id');
  }
  return value._id;
}

function isUploadSuccess(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('success' in value && typeof value.success === 'boolean')
  ) {
    throw new OverleafFileApiContractError('upload', 'it has no boolean success');
  }
  if (!value.success) return false;
  if (!('entity_id' in value && typeof value.entity_id === 'string' && value.entity_id !== '')) {
    throw new OverleafFileApiContractError('upload', 'a successful upload names no entity_id');
  }
  return true;
}
