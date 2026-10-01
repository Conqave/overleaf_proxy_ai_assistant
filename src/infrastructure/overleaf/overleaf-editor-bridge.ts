import type { EditorView, PluginValue } from '@codemirror/view';
import { createChangePreview, type ChangePreview } from './change-preview';
import {
  EXTENSIONS_EVENT,
  getExtensionsEventDetail,
  OverleafHookContractError,
  type ExtensionsEventDetail,
} from './codemirror-api';
import { OverleafStoreContractError } from './overleaf-store';

export interface OpenEditor {
  readonly docId: string;
  readonly view: EditorView;
  readonly preview: ChangePreview;
}

type BridgeFailure = OverleafHookContractError | OverleafStoreContractError;

export class OverleafEditorBridge {
  private current: OpenEditor | null = null;
  private failure: BridgeFailure | null = null;
  private readonly ready = Promise.withResolvers<undefined>();
  private changed = Promise.withResolvers<undefined>();

  constructor(private readonly readOpenDocId: () => string) {}

  install(window: Window): () => void {
    const listener = (event: Event): void => {
      this.extend(this.readEventDetail(event));
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
    return this.ready.promise;
  }

  async whenShowing(docId: string, signal: AbortSignal): Promise<OpenEditor | null> {
    const aborted = Promise.withResolvers<null>();
    const abort = (): void => {
      aborted.resolve(null);
    };
    signal.addEventListener('abort', abort);
    try {
      while (!signal.aborted) {
        if (this.failure !== null) throw this.failure;
        const editor = this.current;
        if (editor?.docId === docId) return editor;
        await Promise.race([this.changed.promise, aborted.promise]);
      }
      return null;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private readEventDetail(event: Event): ExtensionsEventDetail {
    try {
      return getExtensionsEventDetail(event);
    } catch (error) {
      if (!(error instanceof OverleafHookContractError)) throw error;
      this.fail(error);
      throw error;
    }
  }

  private extend({ CodeMirror: cm, extensions }: ExtensionsEventDetail): void {
    const preview = createChangePreview(cm);
    extensions.push(
      preview.extension,
      cm.ViewPlugin.define((view) => this.track({ docId: this.readDocId(), view, preview })),
    );
  }

  private readDocId(): string {
    try {
      return this.readOpenDocId();
    } catch (error) {
      if (!(error instanceof OverleafStoreContractError)) throw error;
      this.fail(error);
      throw error;
    }
  }

  private fail(error: BridgeFailure): void {
    this.failure ??= error;
    this.ready.reject(error);
    this.notifyChange();
  }

  private notifyChange(): void {
    this.changed.resolve(undefined);
    this.changed = Promise.withResolvers<undefined>();
  }

  private track(editor: OpenEditor): PluginValue {
    this.current = editor;
    this.ready.resolve(undefined);
    this.notifyChange();
    return {
      destroy: () => {
        if (this.current === editor) this.current = null;
      },
    };
  }
}
