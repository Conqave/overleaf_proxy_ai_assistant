import { VIEW_TEXT } from './message-format';
import {
  DEFAULT_PANEL_SIZE,
  fitPanelSize,
  type PanelSize,
  type PanelSizeStore,
} from './panel-size';

const KEY_STEP_PX = 10;
const LARGE_KEY_STEP_PX = 50;

interface Growth {
  readonly width: -1 | 0 | 1;
  readonly height: -1 | 0 | 1;
}

const KEY_GROWTH: ReadonlyMap<string, Growth> = new Map<string, Growth>([
  ['ArrowLeft', { width: 1, height: 0 }],
  ['ArrowRight', { width: -1, height: 0 }],
  ['ArrowUp', { width: 0, height: 1 }],
  ['ArrowDown', { width: 0, height: -1 }],
]);

type PanelWindow = Pick<Window, 'document' | 'innerWidth' | 'innerHeight' | 'addEventListener'>;

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startSize: PanelSize;
}

export class PanelResizer {
  readonly handle: HTMLButtonElement;
  private size: PanelSize;
  private drag: Drag | null = null;

  constructor(
    private readonly window: PanelWindow,
    private readonly panel: HTMLElement,
    private readonly store: PanelSizeStore,
  ) {
    this.handle = window.document.createElement('button');
    this.handle.type = 'button';
    this.handle.className = 'ola-resize-handle';
    this.handle.title = VIEW_TEXT.resizeHint;
    this.handle.setAttribute('aria-label', VIEW_TEXT.resizeLabel);
    this.handle.addEventListener('pointerdown', (event) => {
      this.startDrag(event);
    });
    this.handle.addEventListener('pointermove', (event) => {
      this.moveDrag(event);
    });
    this.handle.addEventListener('pointerup', (event) => {
      this.endDrag(event);
    });
    this.handle.addEventListener('pointercancel', (event) => {
      this.endDrag(event);
    });
    this.handle.addEventListener('keydown', (event) => {
      this.resizeByKey(event);
    });
    window.addEventListener('resize', () => {
      this.show(this.size);
    });
    this.size = this.fit(store.load() ?? DEFAULT_PANEL_SIZE);
    this.show(this.size);
  }

  private startDrag(event: PointerEvent): void {
    if (this.drag !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    this.handle.setPointerCapture(event.pointerId);
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSize: this.fit(this.size),
    };
    this.panel.classList.add('is-resizing');
  }

  private moveDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    this.size = this.fit({
      width: drag.startSize.width + drag.startX - event.clientX,
      height: drag.startSize.height + drag.startY - event.clientY,
    });
    this.show(this.size);
  }

  private endDrag(event: PointerEvent): void {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.panel.classList.remove('is-resizing');
    this.store.save(this.size);
  }

  private resizeByKey(event: KeyboardEvent): void {
    const growth = KEY_GROWTH.get(event.key);
    if (growth === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? LARGE_KEY_STEP_PX : KEY_STEP_PX;
    const shown = this.fit(this.size);
    this.size = this.fit({
      width: shown.width + growth.width * step,
      height: shown.height + growth.height * step,
    });
    this.show(this.size);
    this.store.save(this.size);
  }

  private fit(size: PanelSize): PanelSize {
    return fitPanelSize(size, { width: this.window.innerWidth, height: this.window.innerHeight });
  }

  private show(size: PanelSize): void {
    const shown = this.fit(size);
    this.panel.style.setProperty('--ola-panel-width', `${String(shown.width)}px`);
    this.panel.style.setProperty('--ola-panel-height', `${String(shown.height)}px`);
  }
}
