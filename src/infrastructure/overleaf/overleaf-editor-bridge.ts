import type { EditorView, PluginValue } from '@codemirror/view';
import { createChangePreview, type ChangePreview } from './change-preview';
import {
  EXTENSIONS_EVENT,
  getExtensionsEventDetail,
  type ExtensionsEventDetail,
} from './codemirror-api';

export interface OpenEditor {
  readonly view: EditorView;
  readonly preview: ChangePreview;
}

export class OverleafEditorBridge {
  private current: OpenEditor | null = null;
  private preview: ChangePreview | null = null;
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;

  constructor() {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  install(window: Window): () => void {
    const listener = (event: Event): void => {
      this.extend(getExtensionsEventDetail(event));
    };
    window.addEventListener(EXTENSIONS_EVENT, listener);
    return () => {
      window.removeEventListener(EXTENSIONS_EVENT, listener);
    };
  }

  get openEditor(): OpenEditor | null {
    return this.current;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private extend({ CodeMirror: cm, extensions }: ExtensionsEventDetail): void {
    const preview = (this.preview ??= createChangePreview(cm));
    extensions.push(
      preview.extension,
      cm.ViewPlugin.define((view) => this.track({ view, preview })),
    );
  }

  private track(editor: OpenEditor): PluginValue {
    this.current = editor;
    this.markReady();
    return {
      destroy: () => {
        if (this.current === editor) this.current = null;
      },
    };
  }
}
