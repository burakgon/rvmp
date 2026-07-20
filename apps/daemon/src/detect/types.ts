/** Rendered terminal evidence shared by the grid reader and detection layers. */
export interface ScreenGrid {
  rows: string[];
  oscTitle: string | null;
  oscProgress: string | null;
}
