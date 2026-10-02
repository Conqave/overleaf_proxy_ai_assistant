export interface PanelSize {
  readonly width: number;
  readonly height: number;
}

export interface PanelSizeStore {
  load(): PanelSize | null;
  save(size: PanelSize): void;
}

export const DEFAULT_PANEL_SIZE: PanelSize = { width: 380, height: 640 };

export const MIN_PANEL_SIZE: PanelSize = { width: 320, height: 360 };

const VIEWPORT_MARGIN: PanelSize = { width: 40, height: 96 };

export function fitPanelSize(size: PanelSize, viewport: PanelSize): PanelSize {
  return {
    width: fitLength(size.width, MIN_PANEL_SIZE.width, viewport.width - VIEWPORT_MARGIN.width),
    height: fitLength(size.height, MIN_PANEL_SIZE.height, viewport.height - VIEWPORT_MARGIN.height),
  };
}

function fitLength(length: number, min: number, max: number): number {
  return Math.round(Math.max(0, Math.min(Math.max(length, min), max)));
}
