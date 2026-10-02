import type { PanelSize } from '../ports/panel-preferences';

export const DEFAULT_PANEL_SIZE: PanelSize = { width: 380, height: 640 };

export const MIN_PANEL_SIZE: PanelSize = { width: 320, height: 480 };

const PANEL_BOTTOM_PX = 72;
const EDITOR_TOOLBAR_RESERVE_PX = 80;
const VIEWPORT_MARGIN: PanelSize = {
  width: 40,
  height: PANEL_BOTTOM_PX + EDITOR_TOOLBAR_RESERVE_PX,
};

export function fitPanelSize(size: PanelSize, viewport: PanelSize): PanelSize {
  return {
    width: fitLength(size.width, MIN_PANEL_SIZE.width, viewport.width - VIEWPORT_MARGIN.width),
    height: fitLength(size.height, MIN_PANEL_SIZE.height, viewport.height - VIEWPORT_MARGIN.height),
  };
}

function fitLength(length: number, min: number, max: number): number {
  return Math.round(Math.max(0, Math.min(Math.max(length, min), max)));
}
