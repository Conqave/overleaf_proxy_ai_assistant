import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { FakeOverleafStore } from './fake-overleaf-store';
import { TestFixtureError } from './test-errors';

export const FIXTURE_DOCUMENT = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'This report describes the experiment.',
  '\\section{Results}',
  'The results are shown below.',
  '\\end{document}',
].join('\n');

export const FIXTURE_DOC_ID = 'doc-main';

export function openOverleafEditor(
  window: Window & typeof globalThis,
  parent: HTMLElement,
  text: string = FIXTURE_DOCUMENT,
): EditorView {
  const extensions: Extension[] = [];
  window.dispatchEvent(
    new window.CustomEvent('UNSTABLE_editor:extensions', {
      detail: {
        CodeMirror: { Decoration, EditorView, StateEffect, StateField, ViewPlugin, WidgetType },
        extensions,
      },
    }),
  );
  return new EditorView({ parent, state: EditorState.create({ doc: text, extensions }) });
}

export interface FakeEntity {
  readonly _id: string;
  readonly name: string;
}

export interface FakeFolder extends FakeEntity {
  readonly docs: readonly FakeEntity[];
  readonly fileRefs: readonly FakeEntity[];
  readonly folders: readonly FakeFolder[];
}

export const FIXTURE_ROOT_FOLDER: FakeFolder = {
  _id: 'folder-root',
  name: 'rootFolder',
  docs: [
    { _id: FIXTURE_DOC_ID, name: 'main.tex' },
    { _id: 'doc-refs', name: 'refs.bib' },
  ],
  fileRefs: [{ _id: 'file-frog', name: 'frog.jpg' }],
  folders: [
    {
      _id: 'folder-chapters',
      name: 'chapters',
      docs: [],
      fileRefs: [],
      folders: [
        {
          _id: 'folder-intro',
          name: 'intro',
          docs: [{ _id: 'doc-intro', name: 'intro.tex' }],
          fileRefs: [],
          folders: [],
        },
      ],
    },
  ],
};

export const FIXTURE_TEXTS: ReadonlyMap<string, string> = new Map([
  [FIXTURE_DOC_ID, FIXTURE_DOCUMENT],
  ['doc-refs', '@book{knuth84,\n  title = {The TeXbook}\n}'],
  ['doc-intro', '\\section{Introduction}\nThe introduction.'],
]);

export const EMPTY_LOG_ENTRIES = { errors: [], warnings: [], typesetting: [], all: [] };

export class FakeSharedDocument {
  bufferedOps = false;
  savesEdits = true;
  flushes = 0;

  flush(): void {
    this.flushes += 1;
    if (!this.savesEdits) return;
    setTimeout(() => {
      this.bufferedOps = false;
    });
  }

  hasBufferedOps(): boolean {
    return this.bufferedOps;
  }
}

export class FakeOverleafIde {
  readonly store: FakeOverleafStore;
  readonly sharedDocument = new FakeSharedDocument();
  editor: EditorView;
  opensDocs = true;
  compiles = true;
  compileOutcome: 'pdf' | 'http-error' | 'no-output' = 'pdf';
  logEntries: unknown = EMPTY_LOG_ENTRIES;
  compileLog: () => unknown = () => this.logEntries;
  compileCount = 0;
  private readonly treeRoot: HTMLElement;
  private readonly savedTexts = new Map(FIXTURE_TEXTS);

  constructor(
    private readonly window: Window & typeof globalThis,
    rootFolder: FakeFolder = FIXTURE_ROOT_FOLDER,
  ) {
    const { document } = window;
    document.body.innerHTML =
      '<ul class="file-tree"></ul><div id="editor"></div>' +
      '<div class="toolbar-pdf-left"><button class="split-menu-button" data-ol-loading="false">Recompile</button></div>';
    this.treeRoot = this.element('.file-tree');
    this.renderFolder(this.treeRoot, rootFolder);
    this.store = new FakeOverleafStore({
      project: { rootFolder: [rootFolder] },
      'editor.open_doc_id': FIXTURE_DOC_ID,
      'editor.opening': false,
      openFile: null,
      'pdf.logEntries': EMPTY_LOG_ENTRIES,
      'pdf.url': 'build-0',
      'editor.sharejs_doc': this.sharedDocument,
    });
    Object.assign(window, { overleaf: { unstable: { store: this.store } } });
    window.addEventListener('pdf:recompile', this.recompile);
    this.editor = openOverleafEditor(
      window,
      this.element('#editor'),
      this.savedTextOf(FIXTURE_DOC_ID),
    );
  }

  destroy(): void {
    this.window.removeEventListener('pdf:recompile', this.recompile);
    Reflect.deleteProperty(this.window, 'overleaf');
    this.editor.destroy();
  }

  textOf(id: string): string {
    if (id === this.openDocId()) return this.editor.state.doc.toString();
    return this.savedTextOf(id);
  }

  hasText(id: string): boolean {
    return this.savedTexts.has(id);
  }

  reopenEditor(): void {
    this.editor.destroy();
    this.editor = openOverleafEditor(
      this.window,
      this.element('#editor'),
      this.savedTextOf(this.openDocId()),
    );
  }

  isExpanded(folderId: string): boolean {
    return (
      this.entity(folderId).closest('[role="treeitem"]')?.getAttribute('aria-expanded') === 'true'
    );
  }

  click(id: string): void {
    this.entity(id).click();
  }

  remove(id: string): void {
    const item = this.entity(id).closest('[role="treeitem"]');
    if (item === null) throw new TestFixtureError(`${id} is not inside a tree item`);
    item.remove();
  }

  removeFileTree(): void {
    this.treeRoot.remove();
  }

  removeToolbar(): void {
    this.element('.toolbar-pdf-left').remove();
  }

  private readonly recompile = (): void => {
    const button = this.element('.split-menu-button');
    if (!this.compiles || button.dataset.olLoading === 'true') return;
    this.compileCount += 1;
    button.dataset.olLoading = 'true';
    setTimeout(() => {
      button.dataset.olLoading = 'false';
      setTimeout(() => {
        this.publishCompileResult();
      });
    });
  };

  private publishCompileResult(): void {
    switch (this.compileOutcome) {
      case 'pdf':
        this.store.set('pdf.url', `build-${String(this.compileCount)}`);
        this.store.set('pdf.logEntries', null);
        setTimeout(() => {
          this.store.set('pdf.logEntries', structuredClone(this.compileLog()));
        });
        break;
      case 'http-error':
        this.store.set('pdf.url', null);
        this.store.set('pdf.logEntries', null);
        break;
      case 'no-output':
        this.store.set('pdf.logEntries', structuredClone(EMPTY_LOG_ENTRIES));
        break;
    }
  }

  private async openDoc(id: string): Promise<void> {
    if (!this.opensDocs) return;
    if (this.store.get('editor.open_doc_id') === id) {
      this.store.set('openFile', null);
      return;
    }
    this.savedTexts.set(this.openDocId(), this.editor.state.doc.toString());
    this.store.set('editor.open_doc_id', id);
    this.store.set('openFile', null);
    this.store.set('editor.opening', true);
    await Promise.resolve();
    this.store.set('editor.opening', false);
    await new Promise((resolve) => setTimeout(resolve));
    this.editor.destroy();
    this.editor = openOverleafEditor(this.window, this.element('#editor'), this.savedTextOf(id));
  }

  private openDocId(): string {
    const id = this.store.get('editor.open_doc_id');
    if (typeof id !== 'string') throw new TestFixtureError('the store names no open document');
    return id;
  }

  private savedTextOf(id: string): string {
    const text = this.savedTexts.get(id);
    if (text === undefined) throw new TestFixtureError(`no fixture text for ${id}`);
    return text;
  }

  private renderFolder(list: HTMLElement, folder: FakeFolder): void {
    for (const child of folder.folders) {
      const item = this.renderItem(list, child, 'folder');
      item.setAttribute('aria-expanded', 'false');
      const expand = this.window.document.createElement('button');
      expand.innerHTML = '<i class="file-tree-expand-icon"></i>';
      expand.addEventListener('click', (event) => {
        event.stopPropagation();
        item.setAttribute('aria-expanded', 'true');
        const children = this.window.document.createElement('ul');
        item.append(children);
        this.renderFolder(children, child);
      });
      this.entity(child._id).prepend(expand);
    }
    for (const doc of folder.docs) {
      this.renderItem(list, doc, 'doc').addEventListener('click', () => {
        void this.openDoc(doc._id);
      });
    }
    for (const fileRef of folder.fileRefs) {
      this.renderItem(list, fileRef, 'file').addEventListener('click', () => {
        this.store.set('openFile', { _id: fileRef._id, name: fileRef.name, type: 'file' });
      });
    }
  }

  private renderItem(list: HTMLElement, entity: FakeEntity, type: string): HTMLElement {
    const item = this.window.document.createElement('li');
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-label', entity.name);
    const row = this.window.document.createElement('div');
    row.className = 'entity';
    row.dataset.fileId = entity._id;
    row.dataset.fileType = type;
    row.textContent = entity.name;
    item.append(row);
    list.append(item);
    return item;
  }

  private entity(id: string): HTMLElement {
    const entity = [
      ...this.window.document.querySelectorAll<HTMLElement>('.entity[data-file-id]'),
    ].find((element) => element.dataset.fileId === id);
    if (entity === undefined) throw new TestFixtureError(`the tree shows no ${id}`);
    return entity;
  }

  private element(selector: string): HTMLElement {
    const element = this.window.document.querySelector<HTMLElement>(selector);
    if (element === null) throw new TestFixtureError(`the page has no ${selector}`);
    return element;
  }
}
