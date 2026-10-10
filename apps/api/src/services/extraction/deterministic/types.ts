export interface Cell {
  text: string;
  // Present only for geometry-derived cells (PDF text layer).
  x0?: number;
  x1?: number;
}

export interface Line {
  page: number;
  // The line exactly as it appears in the stored page text (cells joined by CELL_SEPARATOR); used as the verbatim snippet.
  raw: string;
  cells: Cell[];
}
