import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_SIZE,
  fitPanelSize,
  MIN_PANEL_SIZE,
} from '../../../src/presentation/panel-size';

const LARGE_VIEWPORT = { width: 1600, height: 1000 };

describe('fitPanelSize', () => {
  it('keeps a size that fits the viewport', () => {
    expect(fitPanelSize({ width: 500, height: 700 }, LARGE_VIEWPORT)).toEqual({
      width: 500,
      height: 700,
    });
  });

  it('raises a size below the minimum to the minimum', () => {
    expect(fitPanelSize({ width: 100, height: 50 }, LARGE_VIEWPORT)).toEqual(MIN_PANEL_SIZE);
  });

  it('keeps the panel inside the viewport margins', () => {
    expect(fitPanelSize({ width: 5000, height: 5000 }, LARGE_VIEWPORT)).toEqual({
      width: 1560,
      height: 904,
    });
  });

  it('lets the viewport win over the minimum on a small screen', () => {
    expect(fitPanelSize(DEFAULT_PANEL_SIZE, { width: 300, height: 400 })).toEqual({
      width: 260,
      height: 304,
    });
  });

  it('never shows a negative size', () => {
    expect(fitPanelSize(DEFAULT_PANEL_SIZE, { width: 10, height: 10 })).toEqual({
      width: 0,
      height: 0,
    });
  });

  it('rounds to whole pixels', () => {
    expect(fitPanelSize({ width: 400.6, height: 500.2 }, LARGE_VIEWPORT)).toEqual({
      width: 401,
      height: 500,
    });
  });
});
