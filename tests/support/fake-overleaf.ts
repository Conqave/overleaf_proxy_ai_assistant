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

export class FakeOverleafIde {
  readonly store: FakeOverleafStore;
  editor: EditorView;
  opensDocs = true;
  compiles = true;
  logEntries: unknown = EMPTY_LOG_ENTRIES;
  private readonly treeRoot: HTMLElement;

  constructor(
    private readonly window: Window & typeof globalThis,
    rootFolder: FakeFolder = FIXTURE_ROOT_FOLDER,
  ) {
    const { document } = window;
    document.body.innerHTML = '<ul class="file-tree"></ul><div id="editor"></div>';
    this.treeRoot = this.element('.file-tree');
    this.renderFolder(this.treeRoot, rootFolder);
    this.store = new FakeOverleafStore({
      project: { rootFolder: [rootFolder] },
      'editor.open_doc_id': FIXTURE_DOC_ID,
      'editor.opening': false,
      'pdf.logEntries': EMPTY_LOG_ENTRIES,
    });
    Object.assign(window, { overleaf: { unstable: { store: this.store } } });
    window.addEventListener('pdf:recompile', this.recompile);
    this.editor = openOverleafEditor(window, this.element('#editor'), this.textOf(FIXTURE_DOC_ID));
  }

  destroy(): void {
    this.window.removeEventListener('pdf:recompile', this.recompile);
    Reflect.deleteProperty(this.window, 'overleaf');
    this.editor.destroy();
  }

  textOf(id: string): string {
    const text = FIXTURE_TEXTS.get(id);
    if (text === undefined) throw new TestFixtureError(`no fixture text for ${id}`);
    return text;
  }

  isExpanded(folderId: string): boolean {
    return (
      this.entity(folderId).closest('[role="treeitem"]')?.getAttribute('aria-expanded') === 'true'
    );
  }

  click(id: string): void {
    this.entity(id).click();
  }

  private readonly recompile = (): void => {
    if (!this.compiles) return;
    this.store.set('pdf.logEntries', null);
    setTimeout(() => {
      this.store.set('pdf.logEntries', structuredClone(this.logEntries));
    });
  };

  private async openDoc(id: string): Promise<void> {
    if (!this.opensDocs) return;
    this.store.set('editor.open_doc_id', id);
    this.store.set('editor.opening', true);
    await Promise.resolve();
    this.store.set('editor.opening', false);
    await new Promise((resolve) => setTimeout(resolve));
    this.editor.destroy();
    this.editor = openOverleafEditor(this.window, this.element('#editor'), this.textOf(id));
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
    for (const fileRef of folder.fileRefs) this.renderItem(list, fileRef, 'file');
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
