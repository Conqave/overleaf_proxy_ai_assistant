import type { CompileDiagnostic } from '../../domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../domain/document';
import { NamedError } from '../../domain/errors';
import { ProjectFileKind, type ProjectFile, type TextFile } from '../../domain/project-file';
import {
  FileOpenTimeoutError,
  NoOpenTextFileError,
  ProjectTreeOutdatedError,
} from '../../ports/errors';
import type { CancellationSignal } from '../../ports/cancellation';
import type { ProjectPort } from '../../ports/project-port';
import { throwAbortReason, withDeadline } from '../deadline';
import { formatDuration } from '../duration';
import { OverleafCompiler } from './overleaf-compiler';
import type { OpenEditor, OverleafEditorBridge } from './overleaf-editor-bridge';
import type { OverleafProjectFiles } from './overleaf-project-files';
import { OverleafStoreContractError, StoreKey, type OverleafStore } from './overleaf-store';
import { readProjectTree } from './project-tree';

const FILE_TREE_SELECTOR = '.file-tree';
const ENTITY_SELECTOR = '.entity[data-file-id]';
const EXPAND_ICON_SELECTOR = '.file-tree-expand-icon';
const FILE_OPEN_MS = 20_000;

export interface OverleafProjectDependencies {
  readonly window: Window & typeof globalThis;
  readonly store: OverleafStore;
  readonly bridge: OverleafEditorBridge;
  readonly files: OverleafProjectFiles;
}

export class OverleafFileTreeContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's file tree does not match the expected contract: ${problem}.`);
  }
}

export class OverleafProjectAdapter implements ProjectPort {
  private readonly compiler: OverleafCompiler;

  constructor(private readonly deps: OverleafProjectDependencies) {
    this.compiler = new OverleafCompiler(deps.window, deps.store);
  }

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
    const text = await this.deps.files.read(file, cancel);
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
      throw new OverleafFileTreeContractError(`the project tree has no entry for ${file.path}`);
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
    return this.compiler.compile(cancel);
  }

  private withFileOpenDeadline<T>(
    file: TextFile,
    cancel: CancellationSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withDeadline(
      FILE_OPEN_MS,
      () =>
        new FileOpenTimeoutError(
          `${file.path} did not open within ${formatDuration(FILE_OPEN_MS)}.`,
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
      throw new ProjectTreeOutdatedError(
        `${file.path} was moved or deleted after the page loaded; reload Overleaf to see the current files.`,
      );
    }
    return entity;
  }
}
