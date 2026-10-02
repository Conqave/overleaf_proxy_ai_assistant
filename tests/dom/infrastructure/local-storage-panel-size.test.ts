import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalStoragePanelSize,
  type StorageWindow,
} from '../../../src/infrastructure/persistence/local-storage-panel-size';

const KEY = 'ola-panel-size';

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

describe('LocalStoragePanelSize', () => {
  it('has no size before one is saved', () => {
    expect(new LocalStoragePanelSize(pageWindow()).load()).toBeNull();
  });

  it('loads only the size of a stored value with extra fields', () => {
    const window = pageWindow();
    window.localStorage.setItem(KEY, '{"width":520,"height":610,"zoom":2}');
    expect(new LocalStoragePanelSize(window).load()).toEqual({ width: 520, height: 610 });
  });

  it('loads the size it saved', () => {
    const window = pageWindow();
    new LocalStoragePanelSize(window).save({ width: 520, height: 610 });
    expect(window.localStorage.getItem(KEY)).toBe('{"width":520,"height":610}');
    expect(new LocalStoragePanelSize(window).load()).toEqual({ width: 520, height: 610 });
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
    expect(new LocalStoragePanelSize(window).load()).toBeNull();
  });

  it('works without a size when the page may not use storage', () => {
    const window = new JSDOM('').window;
    const store = new LocalStoragePanelSize(window);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.load()).toBeNull();
    store.save({ width: 520, height: 610 });
    expect(warn).toHaveBeenCalledWith(
      '[overleaf-ai-assistant] panel size not remembered:',
      expect.stringContaining('localStorage'),
    );
    warn.mockRestore();
  });

  it('keeps working when the storage is full', () => {
    const store = new LocalStoragePanelSize(
      failingWindow(
        (PageDomException) => new PageDomException('quota exceeded', 'QuotaExceededError'),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.save({ width: 520, height: 610 });
    expect(warn).toHaveBeenCalledWith(
      '[overleaf-ai-assistant] panel size not remembered:',
      'quota exceeded',
    );
    warn.mockRestore();
  });

  it('does not hide unexpected storage failures', () => {
    const defect = new TypeError('storage is broken');
    const store = new LocalStoragePanelSize(failingWindow(() => defect));
    expect(() => store.load()).toThrow(defect);
    expect(() => {
      store.save({ width: 520, height: 610 });
    }).toThrow(defect);
  });
});
