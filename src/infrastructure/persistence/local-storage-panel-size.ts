import type { PanelSize, PanelSizeStore } from '../../ports/panel-size-store';

const STORAGE_KEY = 'ola-panel-size';

const UNAVAILABLE_STORAGE = new Set(['SecurityError', 'QuotaExceededError']);

export interface StorageWindow {
  readonly localStorage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly DOMException: typeof DOMException;
}

export class LocalStoragePanelSize implements PanelSizeStore {
  constructor(private readonly window: StorageWindow) {}

  load(): PanelSize | null {
    const stored = this.readStored();
    if (stored === null) return null;
    const size = parseJson(stored);
    return isStoredPanelSize(size) ? { width: size.width, height: size.height } : null;
  }

  save(size: PanelSize): void {
    const text = JSON.stringify({ width: size.width, height: size.height });
    try {
      this.window.localStorage.setItem(STORAGE_KEY, text);
    } catch (error) {
      if (!this.isUnavailableStorage(error)) throw error;
      console.warn('[overleaf-ai-assistant] panel size not remembered:', error.message);
    }
  }

  private readStored(): string | null {
    try {
      return this.window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      if (!this.isUnavailableStorage(error)) throw error;
      return null;
    }
  }

  private isUnavailableStorage(error: unknown): error is DOMException {
    return error instanceof this.window.DOMException && UNAVAILABLE_STORAGE.has(error.name);
  }
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isStoredPanelSize(value: unknown): value is PanelSize {
  if (typeof value !== 'object' || value === null) return false;
  if (!('width' in value) || !('height' in value)) return false;
  return isLength(value.width) && isLength(value.height);
}

function isLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
