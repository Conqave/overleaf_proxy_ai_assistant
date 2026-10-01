import type { CompileDiagnostic } from '../../domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../domain/document';
import { NotATextFileError, ProjectFileNotFoundError } from '../../domain/errors';
import { ProjectFileKind, type ProjectFile } from '../../domain/project-file';
import {
  CompileTimeoutError,
  FileOpenTimeoutError,
  NoOpenTextFileError,
  ProjectFileReadError,
  ProjectUnavailableError,
} from '../../ports/errors';
import type { ProjectPort } from '../../ports/project-port';
import { readCompileDiagnostics } from './compile-log';
import type { OpenEditor, OverleafEditorBridge } from './overleaf-editor-bridge';
import { OverleafStoreContractError, StoreKey, type OverleafStore } from './overleaf-store';
import { readProjectTree } from './project-tree';

export const RECOMPILE_EVENT = 'pdf:recompile';
const TREE_ENTITY_SELECTOR = '.file-tree .entity[data-file-id]';
const EXPAND_ICON_SELECTOR = '.file-tree-expand-icon';

export interface OverleafProjectTimeouts {
  readonly fileOpenMs: number;
  readonly compileMs: number;
}

export interface OverleafProjectDependencies {
  readonly window: Window & typeof globalThis;
  readonly store: OverleafStore;
  readonly bridge: OverleafEditorBridge;
  readonly fetch: typeof fetch;
  readonly projectId: string;
  readonly timeouts: OverleafProjectTimeouts;
}

export class OverleafFileTreeContractError extends Error {
  constructor(problem: string) {
    super(`Overleaf's file tree does not match the expected contract: ${problem}.`);
    this.name = 'OverleafFileTreeContractError';
  }
}

export class OverleafProjectAdapter implements ProjectPort {
  constructor(private readonly deps: OverleafProjectDependencies) {}

  listFiles(): readonly ProjectFile[] {
    return readProjectTree(this.deps.store.get(StoreKey.Project)).files;
  }

  openFilePath(): string {
    if (this.isBinaryFileShown()) {
      throw new NoOpenTextFileError('Overleaf shows a binary file; open a text file to continue.');
    }
    const id = this.openDocId();
    const file = this.listFiles().find((candidate) => candidate.id === id);
    if (file === undefined) {
      throw new OverleafStoreContractError(`the open document ${id} is not in project.rootFolder`);
    }
    return file.path;
  }

  async readFile(file: ProjectFile): Promise<DocumentSnapshot> {
    requireTextFile(file);
    if (file.id === this.openDocId()) {
      const { view } = await this.shownEditor(
        file,
        AbortSignal.timeout(this.deps.timeouts.fileOpenMs),
      );
      return createDocumentSnapshot(view.state.doc.toJSON());
    }
    const response = await this.download(file);
    if (!response.ok) {
      throw new ProjectFileReadError(
        `${file.path} could not be read: Overleaf answered HTTP ${String(response.status)}.`,
      );
    }
    return createDocumentSnapshot((await this.readText(response, file)).split(/\r?\n/));
  }

  async openFile(file: ProjectFile): Promise<void> {
    requireTextFile(file);
    const signal = AbortSignal.timeout(this.deps.timeouts.fileOpenMs);
    if (file.id === this.openDocId() && !this.isBinaryFileShown()) {
      await this.shownEditor(file, signal);
      return;
    }
    const folderIds = readProjectTree(this.deps.store.get(StoreKey.Project)).folderIds.get(file.id);
    if (folderIds === undefined) {
      throw new ProjectFileNotFoundError(`The project has no file ${file.path}.`);
    }
    for (const folderId of folderIds) this.expandFolder(folderId);
    const { store } = this.deps;
    this.findEntity(file.id).click();
    const opened = await store.waitUntil(
      [StoreKey.OpenDocId, StoreKey.Opening, StoreKey.OpenFile],
      () =>
        this.openDocId() === file.id &&
        !store.getBoolean(StoreKey.Opening) &&
        !this.isBinaryFileShown(),
      signal,
    );
    if (!opened) throw this.openTimeout(file);
    await this.shownEditor(file, signal);
  }

  async compile(): Promise<readonly CompileDiagnostic[]> {
    const { store, window } = this.deps;
    const previous = store.get(StoreKey.LogEntries);
    window.dispatchEvent(new window.CustomEvent(RECOMPILE_EVENT));
    const compiled = await store.waitUntil(
      [StoreKey.LogEntries],
      () => {
        const current = store.get(StoreKey.LogEntries);
        return current !== previous && current !== null;
      },
      AbortSignal.timeout(this.deps.timeouts.compileMs),
    );
    if (!compiled) {
      throw new CompileTimeoutError(
        `The project did not compile within ${String(this.deps.timeouts.compileMs)} ms.`,
      );
    }
    return readCompileDiagnostics(store.get(StoreKey.LogEntries));
  }

  private async shownEditor(file: ProjectFile, signal: AbortSignal): Promise<OpenEditor> {
    const editor = await this.deps.bridge.whenShowing(file.id, signal);
    if (editor === null) throw this.openTimeout(file);
    return editor;
  }

  private openTimeout(file: ProjectFile): FileOpenTimeoutError {
    return new FileOpenTimeoutError(
      `${file.path} did not open within ${String(this.deps.timeouts.fileOpenMs)} ms.`,
    );
  }

  private isBinaryFileShown(): boolean {
    const openFile = this.deps.store.get(StoreKey.OpenFile);
    if (openFile === null) return false;
    if (typeof openFile !== 'object') {
      throw new OverleafStoreContractError(`${StoreKey.OpenFile} is neither null nor a file`);
    }
    return true;
  }

  private openDocId(): string {
    return this.deps.store.getString(StoreKey.OpenDocId);
  }

  private async download(file: ProjectFile): Promise<Response> {
    const { projectId } = this.deps;
    try {
      return await this.deps.fetch(`/Project/${projectId}/doc/${file.id}/download`, {
        cache: 'no-store',
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectUnavailableError(`Overleaf could not be reached to read ${file.path}.`, {
        cause: error,
      });
    }
  }

  private async readText(response: Response, file: ProjectFile): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectUnavailableError(`The download of ${file.path} was interrupted.`, {
        cause: error,
      });
    }
  }

  private expandFolder(folderId: string): void {
    const entity = this.findEntity(folderId);
    const item = entity.closest('[role="treeitem"]');
    if (item === null) {
      throw new OverleafFileTreeContractError(`folder ${folderId} is not inside a tree item`);
    }
    if (item.getAttribute('aria-expanded') === 'true') return;
    const button = entity.querySelector(EXPAND_ICON_SELECTOR)?.closest('button');
    if (!button) {
      throw new OverleafFileTreeContractError(`folder ${folderId} has no expand button`);
    }
    button.click();
  }

  private findEntity(id: string): HTMLElement {
    const entities = this.deps.window.document.querySelectorAll<HTMLElement>(TREE_ENTITY_SELECTOR);
    const entity = [...entities].find((element) => element.dataset.fileId === id);
    if (entity === undefined) {
      throw new OverleafFileTreeContractError(`no entry shows the entity ${id}`);
    }
    return entity;
  }
}

function requireTextFile(file: ProjectFile): void {
  if (file.kind !== ProjectFileKind.Text) {
    throw new NotATextFileError(`${file.path} is not a text file.`);
  }
}
