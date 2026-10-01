import type { CompileDiagnostic } from '../../domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../domain/document';
import { NamedError, ProjectFileNotFoundError } from '../../domain/errors';
import { ProjectFileKind, type ProjectFile, type TextFile } from '../../domain/project-file';
import {
  CompileTimeoutError,
  FileOpenTimeoutError,
  NoOpenTextFileError,
  ProjectFileReadError,
  ProjectFileReadTimeoutError,
  ProjectTreeOutdatedError,
  ProjectUnavailableError,
} from '../../ports/errors';
import type { CancellationSignal } from '../../ports/cancellation';
import type { ProjectPort } from '../../ports/project-port';
import { throwAbortReason, withDeadline } from '../deadline';
import { readCompileDiagnostics } from './compile-log';
import type { OpenEditor, OverleafEditorBridge } from './overleaf-editor-bridge';
import { OverleafStoreContractError, StoreKey, type OverleafStore } from './overleaf-store';
import { readProjectTree } from './project-tree';

export const RECOMPILE_EVENT = 'pdf:recompile';
const FILE_TREE_SELECTOR = '.file-tree';
const ENTITY_SELECTOR = '.entity[data-file-id]';
const RECOMPILE_BUTTON_SELECTOR = '.toolbar-pdf-left .split-menu-button[data-ol-loading]';
const LOADING_ATTRIBUTE = 'data-ol-loading';
const HTTP_NOT_FOUND = 404;
const EXPAND_ICON_SELECTOR = '.file-tree-expand-icon';

export interface OverleafProjectTimeouts {
  readonly fileOpenMs: number;
  readonly fileReadMs: number;
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

export class OverleafFileTreeContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's file tree does not match the expected contract: ${problem}.`);
  }
}

export class OverleafToolbarContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's PDF toolbar does not match the expected contract: ${problem}.`);
  }
}

export class OverleafProjectAdapter implements ProjectPort {
  constructor(private readonly deps: OverleafProjectDependencies) {}

  listFiles(): readonly ProjectFile[] {
    return readProjectTree(this.deps.store.get(StoreKey.Project)).files;
  }

  shownFile(): TextFile {
    if (this.isBinaryFileShown()) {
      throw new NoOpenTextFileError('Overleaf shows a binary file; open a text file to continue.');
    }
    const id = this.openDocId();
    const file = this.listFiles().find((candidate) => candidate.id === id);
    if (file === undefined) {
      throw new ProjectTreeOutdatedError(
        'The open file was added after the page loaded; reload Overleaf to work on it.',
      );
    }
    if (file.kind !== ProjectFileKind.Text) {
      throw new OverleafStoreContractError(
        `${StoreKey.OpenDocId} names the binary file ${file.path}`,
      );
    }
    return file;
  }

  isShown(file: TextFile): boolean {
    return !this.isBinaryFileShown() && this.openDocId() === file.id;
  }

  async readFile(file: TextFile, cancel: CancellationSignal): Promise<DocumentSnapshot> {
    if (file.id === this.openDocId()) {
      const { view } = await this.withFileOpenDeadline(file, cancel, (signal) =>
        this.shownEditor(file, signal),
      );
      return createDocumentSnapshot(view.state.doc.toJSON());
    }
    const text = await withDeadline(
      this.deps.timeouts.fileReadMs,
      () =>
        new ProjectFileReadTimeoutError(
          `${file.path} could not be read within ${String(this.deps.timeouts.fileReadMs)} ms.`,
        ),
      [cancel],
      (signal) => this.download(file, signal),
    );
    return createDocumentSnapshot(text.split(/\r?\n/));
  }

  openFile(file: TextFile, cancel: CancellationSignal): Promise<void> {
    return this.withFileOpenDeadline(file, cancel, (signal) => this.open(file, signal));
  }

  private async open(file: TextFile, signal: AbortSignal): Promise<void> {
    if (this.isShown(file)) {
      await this.shownEditor(file, signal);
      return;
    }
    const folderIds = readProjectTree(this.deps.store.get(StoreKey.Project)).folderIds.get(file.id);
    if (folderIds === undefined) {
      throw new ProjectFileNotFoundError(`The project has no file ${file.path}.`);
    }
    for (const folderId of folderIds) this.expandFolder(folderId, file);
    const { store } = this.deps;
    this.findEntity(file.id, file).click();
    const opened = await store.waitUntil(
      [StoreKey.OpenDocId, StoreKey.Opening, StoreKey.OpenFile],
      () =>
        this.openDocId() === file.id &&
        !store.getBoolean(StoreKey.Opening) &&
        !this.isBinaryFileShown(),
      signal,
    );
    if (!opened) throwAbortReason(signal);
    await this.shownEditor(file, signal);
  }

  compile(cancel: CancellationSignal): Promise<readonly CompileDiagnostic[]> {
    return withDeadline(
      this.deps.timeouts.compileMs,
      () =>
        new CompileTimeoutError(
          `The project did not compile within ${String(this.deps.timeouts.compileMs)} ms.`,
        ),
      [cancel],
      (signal) => this.recompile(signal),
    );
  }

  private async recompile(signal: AbortSignal): Promise<readonly CompileDiagnostic[]> {
    const { store, window } = this.deps;
    if (!(await this.whenCompilerIdle(signal))) throwAbortReason(signal);
    const previous = store.get(StoreKey.LogEntries);
    window.dispatchEvent(new window.CustomEvent(RECOMPILE_EVENT));
    const compiled = await store.waitUntil(
      [StoreKey.LogEntries],
      () => {
        const current = store.get(StoreKey.LogEntries);
        return current !== previous && current !== null;
      },
      signal,
    );
    if (!compiled) throwAbortReason(signal);
    return readCompileDiagnostics(store.get(StoreKey.LogEntries));
  }

  private async whenCompilerIdle(signal: AbortSignal): Promise<boolean> {
    const button = this.recompileButton();
    if (!isCompiling(button)) return true;
    const idle = Promise.withResolvers<boolean>();
    const observer = new this.deps.window.MutationObserver(() => {
      if (!isCompiling(button)) idle.resolve(true);
    });
    const abort = (): void => {
      idle.resolve(false);
    };
    observer.observe(button, { attributeFilter: [LOADING_ATTRIBUTE] });
    signal.addEventListener('abort', abort);
    try {
      if (signal.aborted) abort();
      return await idle.promise;
    } finally {
      observer.disconnect();
      signal.removeEventListener('abort', abort);
    }
  }

  private recompileButton(): HTMLElement {
    const button = this.deps.window.document.querySelector<HTMLElement>(RECOMPILE_BUTTON_SELECTOR);
    if (button === null) throw new OverleafToolbarContractError('it has no Recompile button');
    return button;
  }

  private withFileOpenDeadline<T>(
    file: TextFile,
    cancel: CancellationSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withDeadline(
      this.deps.timeouts.fileOpenMs,
      () =>
        new FileOpenTimeoutError(
          `${file.path} did not open within ${String(this.deps.timeouts.fileOpenMs)} ms.`,
        ),
      [cancel],
      run,
    );
  }

  private async shownEditor(file: TextFile, signal: AbortSignal): Promise<OpenEditor> {
    const editor = await this.deps.bridge.whenShowing(file.id, signal);
    if (editor === null) throwAbortReason(signal);
    return editor;
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

  private async download(file: TextFile, signal: AbortSignal): Promise<string> {
    const response = await this.requestDownload(file, signal);
    if (response.status === HTTP_NOT_FOUND) {
      throw new ProjectFileNotFoundError(`${file.path} is no longer in the project.`);
    }
    if (!response.ok) {
      throw new ProjectFileReadError(
        `${file.path} could not be read: Overleaf answered HTTP ${String(response.status)}.`,
      );
    }
    return await this.readText(response, file, signal);
  }

  private async requestDownload(file: TextFile, signal: AbortSignal): Promise<Response> {
    const { projectId } = this.deps;
    try {
      return await this.deps.fetch(`/Project/${projectId}/doc/${file.id}/download`, {
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectUnavailableError(`Overleaf could not be reached to read ${file.path}.`, {
        cause: error,
      });
    }
  }

  private async readText(response: Response, file: TextFile, signal: AbortSignal): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectUnavailableError(`The download of ${file.path} was interrupted.`, {
        cause: error,
      });
    }
  }

  private expandFolder(folderId: string, file: TextFile): void {
    const entity = this.findEntity(folderId, file);
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

  private findEntity(id: string, file: TextFile): HTMLElement {
    const tree = this.deps.window.document.querySelector(FILE_TREE_SELECTOR);
    if (tree === null) throw new OverleafFileTreeContractError('the page shows no file tree');
    const entities = tree.querySelectorAll<HTMLElement>(ENTITY_SELECTOR);
    const entity = [...entities].find((element) => element.dataset.fileId === id);
    if (entity === undefined) {
      throw new ProjectFileNotFoundError(`${file.path} is no longer in the project's file tree.`);
    }
    return entity;
  }
}

function isCompiling(button: HTMLElement): boolean {
  const loading = button.getAttribute(LOADING_ATTRIBUTE);
  if (loading !== 'true' && loading !== 'false') {
    throw new OverleafToolbarContractError(
      `the Recompile button has ${LOADING_ATTRIBUTE}=${String(loading)}`,
    );
  }
  return loading === 'true';
}
