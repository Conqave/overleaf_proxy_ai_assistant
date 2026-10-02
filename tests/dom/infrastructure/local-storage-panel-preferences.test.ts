import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalStoragePanelPreferences,
  type StorageWindow,
} from '../../../src/infrastructure/persistence/local-storage-panel-preferences';

const KEY = 'ola-panel-size';
const COLLAPSED_KEY = 'ola-panel-collapsed';

function pageWindow() {
  return new JSDOM('', { url: 'http://overleaf.test/project/1' }).window;
}

function failingWindow(createError: (domException: typeof DOMException) => Error): StorageWindow {
  const { DOMException } = pageWindow();
  const error = createError(DOMException);
  const fail = (): never => {
    throw error;
  };
  return { DOMException, localStorage: { getItem: fail, setItem: fail } };
}

describe('LocalStoragePanelPreferences', () => {
  it('has no size before one is saved', () => {
    expect(new LocalStoragePanelPreferences(pageWindow()).loadSize()).toBeNull();
  });

  it('loads only the size of a stored value with extra fields', () => {
    const window = pageWindow();
    window.localStorage.setItem(KEY, '{"width":520,"height":610,"zoom":2}');
    expect(new LocalStoragePanelPreferences(window).loadSize()).toEqual({
      width: 520,
      height: 610,
    });
  });

  it('loads the size it saved', () => {
    const window = pageWindow();
    new LocalStoragePanelPreferences(window).saveSize({ width: 520, height: 610 });
    expect(window.localStorage.getItem(KEY)).toBe('{"width":520,"height":610}');
    expect(new LocalStoragePanelPreferences(window).loadSize()).toEqual({
      width: 520,
      height: 610,
    });
  });

  it.each([
    'not json',
    '{"width":520}',
    '{"width":-5,"height":610}',
    '{"width":0,"height":610}',
    '{"width":"520","height":610}',
    '{"width":1e999,"height":610}',
    '[520,610]',
    '"520x610"',
    'null',
  ])('ignores the corrupt stored value %s', (stored) => {
    const window = pageWindow();
    window.localStorage.setItem(KEY, stored);
    expect(new LocalStoragePanelPreferences(window).loadSize()).toBeNull();
  });

  it('remembers whether the panel is collapsed', () => {
    const window = pageWindow();
    const preferences = new LocalStoragePanelPreferences(window);
    expect(preferences.loadCollapsed()).toBe(false);
    preferences.saveCollapsed(true);
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('true');
    expect(new LocalStoragePanelPreferences(window).loadCollapsed()).toBe(true);
    preferences.saveCollapsed(false);
    expect(new LocalStoragePanelPreferences(window).loadCollapsed()).toBe(false);
  });

  it('shows the panel for an unknown collapsed value', () => {
    const window = pageWindow();
    window.localStorage.setItem(COLLAPSED_KEY, 'yes');
    expect(new LocalStoragePanelPreferences(window).loadCollapsed()).toBe(false);
  });

  it('works without a size when the page may not use storage', () => {
    const window = new JSDOM('').window;
    const store = new LocalStoragePanelPreferences(window);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.loadSize()).toBeNull();
    store.saveSize({ width: 520, height: 610 });
    expect(warn).toHaveBeenCalledWith(
      '[overleaf-ai-assistant] panel layout not remembered:',
      expect.stringContaining('localStorage'),
    );
    warn.mockRestore();
  });

  it('keeps working when the storage is full', () => {
    const store = new LocalStoragePanelPreferences(
      failingWindow(
        (PageDomException) => new PageDomException('quota exceeded', 'QuotaExceededError'),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.saveSize({ width: 520, height: 610 });
    expect(warn).toHaveBeenCalledWith(
      '[overleaf-ai-assistant] panel layout not remembered:',
      'quota exceeded',
    );
    warn.mockRestore();
  });

  it('does not hide unexpected storage failures', () => {
    const defect = new TypeError('storage is broken');
    const store = new LocalStoragePanelPreferences(failingWindow(() => defect));
    expect(() => store.loadSize()).toThrow(defect);
    expect(() => {
      store.saveSize({ width: 520, height: 610 });
    }).toThrow(defect);
  });
});
