import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { PanelResizer } from '../../../src/presentation/panel-resizer';
import { LocalStoragePanelSize } from '../../../src/infrastructure/persistence/local-storage-panel-size';
import { pointerEventOf } from '../../support/guards';

const KEY = 'ola-panel-size';

function openPage(width = 1600, height = 1000) {
  const { window } = new JSDOM('<!doctype html><body></body>', {
    url: 'http://overleaf.test/project/1',
  });
  const captured: number[] = [];
  Object.assign(window.HTMLElement.prototype, {
    setPointerCapture(pointerId: number) {
      captured.push(pointerId);
    },
  });
  const viewport = (newWidth: number, newHeight: number) => {
    Object.assign(window, { innerWidth: newWidth, innerHeight: newHeight });
    window.dispatchEvent(new window.Event('resize'));
  };
  viewport(width, height);
  const mount = () => {
    const panel = window.document.createElement('section');
    const resizer = new PanelResizer(window, panel, new LocalStoragePanelSize(window));
    panel.append(resizer.handle);
    window.document.body.append(panel);
    const shown = () => ({
      width: panel.style.getPropertyValue('--ola-panel-width'),
      height: panel.style.getPropertyValue('--ola-panel-height'),
    });
    const PagePointerEvent = pointerEventOf(window);
    const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) => {
      resizer.handle.dispatchEvent(
        new PagePointerEvent(type, {
          pointerId: 7,
          isPrimary: true,
          button: 0,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    };
    const key = (name: string, shiftKey = false) => {
      resizer.handle.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: name,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    return { panel, handle: resizer.handle, shown, pointer, key };
  };
  return { window, captured, viewport, mount, stored: () => window.localStorage.getItem(KEY) };
}

describe('PanelResizer', () => {
  it('shows the default size and offers a labelled handle', () => {
    const { mount } = openPage();
    const { handle, shown } = mount();
    expect(shown()).toEqual({ width: '380px', height: '640px' });
    expect(handle.getAttribute('aria-label')).toBe('Resize the Hans panel');
    expect(handle.type).toBe('button');
  });

  it('restores the size remembered by this browser', () => {
    const { window, mount } = openPage();
    window.localStorage.setItem(KEY, '{"width":600,"height":500}');
    expect(mount().shown()).toEqual({ width: '600px', height: '500px' });
  });

  it('shows the default size for a corrupt remembered value', () => {
    const { window, mount } = openPage();
    window.localStorage.setItem(KEY, '{"width":"wide"}');
    expect(mount().shown()).toEqual({ width: '380px', height: '640px' });
  });

  it('resizes while the corner is dragged and remembers the size on release', () => {
    const { mount, captured, stored } = openPage();
    const { panel, pointer, shown } = mount();
    pointer('pointerdown', 500, 300);
    expect(captured).toEqual([7]);
    expect(panel.classList.contains('is-resizing')).toBe(true);
    pointer('pointermove', 400, 250);
    expect(shown()).toEqual({ width: '480px', height: '690px' });
    expect(stored()).toBeNull();
    pointer('pointerup', 380, 240);
    expect(shown()).toEqual({ width: '480px', height: '690px' });
    expect(stored()).toBe('{"width":480,"height":690}');
    expect(panel.classList.contains('is-resizing')).toBe(false);
  });

  it('keeps a dragged size between the minimum and the viewport', () => {
    const { mount, stored } = openPage();
    const { pointer, shown } = mount();
    pointer('pointerdown', 500, 300);
    pointer('pointermove', 900, 900);
    expect(shown()).toEqual({ width: '320px', height: '480px' });
    pointer('pointermove', -2000, -2000);
    expect(shown()).toEqual({ width: '1560px', height: '848px' });
    pointer('pointercancel', -2000, -2000);
    expect(stored()).toBe('{"width":1560,"height":848}');
  });

  it('ignores secondary buttons and other pointers', () => {
    const { mount, stored } = openPage();
    const { pointer, shown } = mount();
    pointer('pointerdown', 500, 300, { button: 2 });
    pointer('pointermove', 400, 200);
    expect(shown()).toEqual({ width: '380px', height: '640px' });
    pointer('pointerdown', 500, 300);
    pointer('pointermove', 300, 100, { pointerId: 8, isPrimary: false });
    pointer('pointerup', 300, 100, { pointerId: 8, isPrimary: false });
    expect(shown()).toEqual({ width: '380px', height: '640px' });
    expect(stored()).toBeNull();
  });

  it('resizes with the arrow keys and remembers each step', () => {
    const { mount, stored } = openPage();
    const { key, shown } = mount();
    key('ArrowLeft');
    key('ArrowUp', true);
    expect(shown()).toEqual({ width: '390px', height: '690px' });
    key('ArrowRight', true);
    key('ArrowDown');
    expect(shown()).toEqual({ width: '340px', height: '680px' });
    expect(stored()).toBe('{"width":340,"height":680}');
    key('Enter');
    expect(shown()).toEqual({ width: '340px', height: '680px' });
  });

  it('stays inside a shrinking window and returns to the chosen size', () => {
    const { mount, viewport, stored } = openPage();
    const { key, shown } = mount();
    key('ArrowLeft', true);
    expect(shown()).toEqual({ width: '430px', height: '640px' });
    viewport(400, 500);
    expect(shown()).toEqual({ width: '360px', height: '348px' });
    viewport(1600, 1000);
    expect(shown()).toEqual({ width: '430px', height: '640px' });
    expect(stored()).toBe('{"width":430,"height":640}');
  });
});
