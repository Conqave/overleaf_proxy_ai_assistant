export interface PanelSize {
  readonly width: number;
  readonly height: number;
}

export interface PanelSizeStore {
  load(): PanelSize | null;
  save(size: PanelSize): void;
}
