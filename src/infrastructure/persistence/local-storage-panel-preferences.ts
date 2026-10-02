import type { PanelPreferences, PanelSize } from '../../ports/panel-preferences';

const SIZE_KEY = 'ola-panel-size';
const COLLAPSED_KEY = 'ola-panel-collapsed';
const COLLAPSED = 'true';
const EXPANDED = 'false';

const UNAVAILABLE_STORAGE = new Set(['SecurityError', 'QuotaExceededError']);

export interface StorageWindow {
  readonly localStorage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly DOMException: typeof DOMException;
}

export class LocalStoragePanelPreferences implements PanelPreferences {
  constructor(private readonly window: StorageWindow) {}

  loadSize(): PanelSize | null {
    const stored = this.read(SIZE_KEY);
    if (stored === null) return null;
    const size = parseJson(stored);
    return isStoredPanelSize(size) ? { width: size.width, height: size.height } : null;
  }

  saveSize(size: PanelSize): void {
    this.write(SIZE_KEY, JSON.stringify({ width: size.width, height: size.height }));
  }

  loadCollapsed(): boolean {
    return this.read(COLLAPSED_KEY) === COLLAPSED;
  }

  saveCollapsed(collapsed: boolean): void {
    this.write(COLLAPSED_KEY, collapsed ? COLLAPSED : EXPANDED);
  }

  private read(key: string): string | null {
    try {
      return this.window.localStorage.getItem(key);
    } catch (error) {
      if (!this.isUnavailableStorage(error)) throw error;
      return null;
    }
  }

  private write(key: string, text: string): void {
    try {
      this.window.localStorage.setItem(key, text);
    } catch (error) {
      if (!this.isUnavailableStorage(error)) throw error;
      console.warn('[overleaf-ai-assistant] panel layout not remembered:', error.message);
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
