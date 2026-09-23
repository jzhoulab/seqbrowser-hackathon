import { describe, expect, it } from 'vitest';

import {
  NAVIGATOR_FLANK_BP,
  navigatorWindow,
  snapWindowToGrid,
} from '../lib/navigatorWindow';

const CHR1_LENGTH = 248_956_422;

describe('navigator window', () => {
  it('frames the view with a flank on each side', () => {
    const window = navigatorWindow({ start: 5_000_000, end: 5_010_000 }, CHR1_LENGTH);

    expect(window).toEqual({ start: 4_900_000, end: 5_110_000 });
  });

  it('keeps its full width against the start of the chromosome', () => {
    const window = navigatorWindow({ start: 1_000, end: 4_000 }, CHR1_LENGTH);

    expect(window.start).toBe(0);
    expect(window.end - window.start).toBe(3_000 + NAVIGATOR_FLANK_BP * 2);
  });

  it('keeps its full width against the end of the chromosome', () => {
    const window = navigatorWindow(
      { start: CHR1_LENGTH - 3_000, end: CHR1_LENGTH },
      CHR1_LENGTH,
    );

    expect(window.end).toBe(CHR1_LENGTH);
    expect(window.end - window.start).toBe(3_000 + NAVIGATOR_FLANK_BP * 2);
  });

  it('always contains the view, however far it is zoomed out', () => {
    const range = { start: 10_000_000, end: 30_000_000 };
    const window = navigatorWindow(range, CHR1_LENGTH);

    expect(window.start).toBeLessThanOrEqual(range.start);
    expect(window.end).toBeGreaterThanOrEqual(range.end);
  });

  it('falls back to the whole chromosome when it is shorter than the window', () => {
    // chrM is 16.5 kb -- an order of magnitude under a single flank.
    expect(navigatorWindow({ start: 100, end: 900 }, 16_569)).toEqual({ start: 0, end: 16_569 });
  });

  it('survives a degenerate range', () => {
    const window = navigatorWindow({ start: Number.NaN, end: Number.NaN }, CHR1_LENGTH);

    expect(Number.isFinite(window.start)).toBe(true);
    expect(window.end).toBeGreaterThan(window.start);
  });
});

describe('navigator request grid', () => {
  it('widens a window outward to the grid so panning re-uses one request', () => {
    const first = snapWindowToGrid({ start: 4_900_000, end: 5_110_000 }, CHR1_LENGTH);
    const afterSmallPan = snapWindowToGrid({ start: 4_905_000, end: 5_115_000 }, CHR1_LENGTH);

    expect(first).toEqual({ start: 4_900_000, end: 5_125_000 });
    expect(afterSmallPan).toEqual(first);
  });

  it('covers the window it was given', () => {
    const window = { start: 4_912_345, end: 5_098_765 };
    const snapped = snapWindowToGrid(window, CHR1_LENGTH);

    expect(snapped.start).toBeLessThanOrEqual(window.start);
    expect(snapped.end).toBeGreaterThanOrEqual(window.end);
  });

  it('does not run past the end of the chromosome', () => {
    const snapped = snapWindowToGrid(
      { start: CHR1_LENGTH - 1_000, end: CHR1_LENGTH },
      CHR1_LENGTH,
    );

    expect(snapped.end).toBe(CHR1_LENGTH);
  });
});
