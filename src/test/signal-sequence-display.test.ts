import { describe, expect, it } from 'vitest';
import {
  computeSequenceGlyphFit,
  buildSequenceSignalColumns,
  chooseSequenceSignalRenderMode,
  computeSignalBarGeometry,
} from '../lib/signalSequenceDisplay';
import type { TrackFeature } from '../types';

const perBaseFeatures: TrackFeature[] = [
  { start: 100, end: 101, score: 2 },
  { start: 101, end: 102, score: -1 },
];

describe('sequence signal display', () => {
  it('uses letters and cells only for genuine one-value-per-base data', () => {
    expect(chooseSequenceSignalRenderMode(1 / 6.5, 1, 1, perBaseFeatures)).toBe('letters');
    expect(chooseSequenceSignalRenderMode(1 / 6.49, 1, 1, perBaseFeatures)).toBe('cells');
    expect(chooseSequenceSignalRenderMode(1 / 1.49, 1, 1, perBaseFeatures)).toBe('signal');
    expect(chooseSequenceSignalRenderMode(0.1, 2, 1, perBaseFeatures)).toBe('signal');
    expect(chooseSequenceSignalRenderMode(0.1, 1, 2, perBaseFeatures)).toBe('signal');
    expect(
      chooseSequenceSignalRenderMode(0.1, 1, 1, [{ start: 100, end: 102, score: 1 }]),
    ).toBe('signal');
  });

  it('joins model values to absolute genomic bases without inventing uncovered columns', () => {
    expect(
      buildSequenceSignalColumns(
        [...perBaseFeatures, { start: 102, end: 104, score: 9 }],
        { sequence: 'ACGT', start: 100, end: 104 },
        100,
        104,
      ).map(({ base, position, feature }) => [base, position, feature.score]),
    ).toEqual([
      ['A', 100, 2],
      ['C', 101, -1],
    ]);
  });

  it('places positive and negative bases on opposite sides of the same zero baseline', () => {
    const positive = computeSignalBarGeometry(2, { min: -4, max: 4 }, 10, 90);
    const negative = computeSignalBarGeometry(-2, { min: -4, max: 4 }, 10, 90);

    expect(positive).toMatchObject({ baselineY: 50, valueY: 30, y: 30, height: 20, direction: 'positive' });
    expect(negative).toMatchObject({ baselineY: 50, valueY: 70, y: 50, height: 20, direction: 'negative' });
  });

  it('respects an asymmetric fixed domain while retaining a truthful zero baseline', () => {
    const geometry = computeSignalBarGeometry(-1, { min: -2, max: 6 }, 0, 80);
    expect(geometry).toMatchObject({ baselineY: 60, valueY: 70, y: 60, height: 10, direction: 'negative' });
  });
});

describe('computeSequenceGlyphFit', () => {
  // Letters used to be drawn at their natural monospace advance width inside a wider
  // base column, so a quarter of each column showed up as a gap between letters.
  const MONOSPACE_ADVANCE_PX = 7.22; // measured for '800 12px ui-monospace'

  it('stretches a glyph to span its base column', () => {
    const pxPerBase = 10;
    const { width, scaleX } = computeSequenceGlyphFit(pxPerBase, MONOSPACE_ADVANCE_PX);
    const drawnPx = MONOSPACE_ADVANCE_PX * scaleX;
    expect(drawnPx).toBeCloseTo(width, 5);
    // At most a hairline of the column is left empty.
    expect(pxPerBase - drawnPx).toBeLessThan(0.5);
  });

  it('does not cap the scale at 1 when the column is wider than the glyph', () => {
    const { scaleX } = computeSequenceGlyphFit(10, MONOSPACE_ADVANCE_PX);
    expect(scaleX).toBeGreaterThan(1);
  });

  it('keeps a gap between adjacent columns so letters stay separable', () => {
    const pxPerBase = 12;
    const { width } = computeSequenceGlyphFit(pxPerBase, MONOSPACE_ADVANCE_PX);
    expect(width).toBeLessThan(pxPerBase);
  });

  it('shrinks a glyph that is wider than its column', () => {
    const { scaleX } = computeSequenceGlyphFit(4, MONOSPACE_ADVANCE_PX);
    expect(scaleX).toBeLessThan(1);
    expect(scaleX).toBeGreaterThan(0);
  });

  it('never collapses to zero width at sub-pixel bases', () => {
    const { width, scaleX } = computeSequenceGlyphFit(0.2, MONOSPACE_ADVANCE_PX);
    expect(width).toBeGreaterThan(0);
    expect(scaleX).toBeGreaterThanOrEqual(0.1);
  });
});
