/** Context shown on each side of the viewport in the navigator strip. */
export const NAVIGATOR_FLANK_BP = 100_000;

/**
 * Requests are snapped to this grid so panning re-uses one cached navigator
 * window instead of issuing a fetch per pixel of travel.
 */
export const NAVIGATOR_REQUEST_GRID_BP = 25_000;

export type NavigatorWindow = {
  start: number;
  end: number;
};

/**
 * The stretch of chromosome the navigator draws: the current view plus a fixed
 * flank on each side.
 *
 * The window keeps its full width wherever the chromosome allows it, sliding
 * inward at the telomeres rather than shrinking, so the strip holds a steady
 * bp-per-pixel while panning instead of stretching as an edge is approached.
 * Only a chromosome shorter than the whole window falls back to its full length.
 */
export function navigatorWindow(
  range: { start: number; end: number },
  chrLength: number,
  flankBp: number = NAVIGATOR_FLANK_BP,
): NavigatorWindow {
  const safeChrLength = Number.isFinite(chrLength) && chrLength > 0 ? chrLength : 1;
  const safeFlank = Number.isFinite(flankBp) && flankBp > 0 ? flankBp : 0;

  const rawStart = Number.isFinite(range.start) ? range.start : 0;
  const rawEnd = Number.isFinite(range.end) ? range.end : rawStart + 1;
  const viewStart = Math.max(0, Math.min(rawStart, rawEnd));
  const viewEnd = Math.min(safeChrLength, Math.max(rawStart, rawEnd));
  const viewSpan = Math.max(1, viewEnd - viewStart);

  const desiredWidth = viewSpan + safeFlank * 2;
  if (desiredWidth >= safeChrLength) {
    return { start: 0, end: safeChrLength };
  }

  const start = Math.min(Math.max(0, viewStart - safeFlank), safeChrLength - desiredWidth);
  return { start, end: start + desiredWidth };
}

/** Widen a window outward to the request grid, without leaving the chromosome. */
export function snapWindowToGrid(
  window: NavigatorWindow,
  chrLength: number,
  gridBp: number = NAVIGATOR_REQUEST_GRID_BP,
): NavigatorWindow {
  const safeChrLength = Number.isFinite(chrLength) && chrLength > 0 ? chrLength : 1;
  const safeGrid = Number.isFinite(gridBp) && gridBp >= 1 ? gridBp : 1;

  const start = Math.max(0, Math.floor(window.start / safeGrid) * safeGrid);
  const end = Math.min(safeChrLength, Math.ceil(window.end / safeGrid) * safeGrid);

  return { start, end: Math.max(start + 1, end) };
}
