export interface PanelSize {
  readonly width: number;
  readonly height: number;
}

export interface PanelPreferences {
  loadSize(): PanelSize | null;
  saveSize(size: PanelSize): void;
  loadCollapsed(): boolean;
  saveCollapsed(collapsed: boolean): void;
}
