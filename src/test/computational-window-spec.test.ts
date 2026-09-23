import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveComputationalNeighborSpecs, deriveTrackWindowSpec } from '../lib/trackWindowSpec';
import {
  recordInferenceCalibration,
  resetInferenceCalibration,
} from '../lib/computationalLimits';
import type { DataWindowSpec, TrackSpec, ViewportState } from '../types';

const viewport: ViewportState = {
  chr: 'chr1',
  chrLength: 249_250_621,
  widthPx: 1400,
  centerBp: 124_040_000,
  bpPerPx: 20,
  range: {
    start: 124_026_000,
    end: 124_054_000,
    span: 28_000,
  },
};

const baseSpec: DataWindowSpec = {
  key: 'chr1:124000000:124200000:r10',
  requestStart: 124_000_000,
  requestEnd: 124_200_000,
  resolutionBp: 10,
};

const computationalTrack = {
  id: 'comp-1',
  name: 'Comp',
  kind: 'signal',
  color: '#f00',
  height: 76,
  source: {
    type: 'computational',
    packUrl: '/computational/packs/seqbro2-puffin.czpack',
    pack: {
      schemaVersion: 1,
      id: 'seqbro2-puffin',
      name: 'Seqbro2 Puffin',
      sequenceProvider: {
        type: 'ucsc',
        genome: 'hg38',
      },
      model: {
        format: 'onnx',
        url: '/computational/models/seqbro2-puffin.onnx',
      },
      inference: {
        flankBp: 325,
        maxWindowBp: 86_000,
        maxResolutionBp: 24,
      },
      subtracks: [
        {
          id: 'plus',
          name: 'plus',
          kind: 'signal',
          color: '#f00',
          height: 76,
          outputName: 'y_pred',
        },
      ],
    },
    subtrack: {
      id: 'plus',
      name: 'plus',
      kind: 'signal',
      color: '#f00',
      height: 76,
      outputName: 'y_pred',
    },
  },
} satisfies TrackSpec;

const stableComputationalTrack: TrackSpec = {
  ...computationalTrack,
  id: 'comp-stable',
  source: {
    ...computationalTrack.source,
    subtrack: {
      ...computationalTrack.source.subtrack,
      stableMarginBp: 325,
    },
  },
};

const nonComputationalTrack: TrackSpec = {
  id: 'bw-1',
  name: 'BW',
  kind: 'signal',
  color: '#0af',
  height: 76,
  source: {
    type: 'bigwig',
    url: 'https://example.com/track.bw',
  },
};

describe('computational window spec derivation', () => {
  // These tests cover window geometry (snapping, viewport coverage), which is only
  // meaningful once the budgeted cap allows a real window. Seed a fast measured cost
  // so puffin's cap is its declared 86kb, isolating geometry from the cost budget.
  beforeEach(() => {
    recordInferenceCalibration('/computational/models/seqbro2-puffin.onnx', 0.001);
  });
  afterEach(() => {
    resetInferenceCalibration();
  });

  it('returns the original spec for non-computational tracks', () => {
    const result = deriveTrackWindowSpec(nonComputationalTrack, viewport, baseSpec);
    expect(result).toEqual(baseSpec);
  });

  it('requests true one-base values for a sequence-height track only while bases are drawable', () => {
    const sequenceTrack: TrackSpec = {
      ...stableComputationalTrack,
      signalDisplay: 'sequence',
    };
    const baseViewport = {
      ...viewport,
      bpPerPx: 0.5,
      range: { start: 9_750, end: 10_250, span: 500 },
    };

    expect(deriveTrackWindowSpec(sequenceTrack, baseViewport, { ...baseSpec, resolutionBp: 5 }).resolutionBp)
      .toBe(1);
    expect(
      deriveTrackWindowSpec(
        sequenceTrack,
        { ...baseViewport, bpPerPx: 1, range: { start: 9_500, end: 10_500, span: 1_000 } },
        { ...baseSpec, resolutionBp: 5 },
      ).resolutionBp,
    ).toBe(5);
  });

  it('derives a larger snapped window for computational tracks', () => {
    const result = deriveTrackWindowSpec(computationalTrack, viewport, baseSpec);
    const span = result.requestEnd - result.requestStart;
    expect(span).toBe(Math.floor(viewport.range.span * 2.5));
    expect(span).toBeLessThanOrEqual(86_000);
    expect(result.requestStart).toBeLessThanOrEqual(viewport.range.start);
    expect(result.requestEnd).toBeGreaterThanOrEqual(viewport.range.end);
  });

  it('caps the larger overscan window at the model budget', () => {
    const wideViewport: ViewportState = {
      ...viewport,
      bpPerPx: 40,
      range: {
        start: viewport.centerBp - 28_000,
        end: viewport.centerBp + 28_000,
        span: 56_000,
      },
    };

    const result = deriveTrackWindowSpec(computationalTrack, wideViewport, baseSpec);
    expect(result.requestEnd - result.requestStart).toBe(86_000);
    expect(result.requestStart).toBeLessThanOrEqual(wideViewport.range.start);
    expect(result.requestEnd).toBeGreaterThanOrEqual(wideViewport.range.end);
  });

  it('builds neighboring specs for prewarm', () => {
    const current = deriveTrackWindowSpec(computationalTrack, viewport, baseSpec);
    const neighbors = deriveComputationalNeighborSpecs(computationalTrack, viewport, current);
    const span = current.requestEnd - current.requestStart;
    const expectedStride = Math.max(1, Math.min(Math.floor(span - viewport.range.span) - 1, span - 1));

    expect(neighbors).toHaveLength(2);
    expect(neighbors.map((neighbor) => neighbor.requestStart)).toEqual([
      current.requestStart - expectedStride,
      current.requestStart + expectedStride,
    ]);
    for (const neighbor of neighbors) {
      expect(neighbor.requestStart).toBeGreaterThanOrEqual(0);
      expect(neighbor.requestEnd).toBeLessThanOrEqual(viewport.chrLength);
      expect(neighbor.requestEnd - neighbor.requestStart).toBe(span);
      expect(neighbor.requestStart).not.toBe(current.requestStart);
    }
  });

  it('prefetches the exact next snapped request during a slow pan', () => {
    // Match the calibrated Puffin demo regime: the 2.5x target is capped to 5kb,
    // leaving a deterministic overlapping stride on a 2.4kb viewport.
    recordInferenceCalibration('/computational/models/seqbro2-puffin.onnx', 0.1);
    const demoViewport: ViewportState = {
      chr: 'chr7',
      chrLength: 159_345_973,
      widthPx: 875,
      centerBp: 5_530_600,
      bpPerPx: 2_400 / 875,
      range: {
        start: 5_529_400,
        end: 5_531_800,
        span: 2_400,
      },
    };
    const current = deriveTrackWindowSpec(computationalTrack, demoViewport, baseSpec);
    const span = current.requestEnd - current.requestStart;
    const stride = Math.max(1, Math.min(Math.floor(span - demoViewport.range.span) - 1, span - 1));
    const neighbors = deriveComputationalNeighborSpecs(computationalTrack, demoViewport, current);

    const panBy = (delta: number): ViewportState => ({
      ...demoViewport,
      centerBp: demoViewport.centerBp + delta,
      range: {
        start: demoViewport.range.start + delta,
        end: demoViewport.range.end + delta,
        span: demoViewport.range.span,
      },
    });
    const previous = deriveTrackWindowSpec(computationalTrack, panBy(-stride), baseSpec);
    const next = deriveTrackWindowSpec(computationalTrack, panBy(stride), baseSpec);

    expect(span).toBe(5_000);
    expect(previous.requestStart).toBe(current.requestStart - stride);
    expect(next.requestStart).toBe(current.requestStart + stride);
    expect(neighbors).toEqual([
      expect.objectContaining({
        requestStart: previous.requestStart,
        requestEnd: previous.requestEnd,
      }),
      expect.objectContaining({
        requestStart: next.requestStart,
        requestEnd: next.requestEnd,
      }),
    ]);
  });

  it('keeps a stable-margin output safely outside a base-resolution viewport', () => {
    const baseViewport: ViewportState = {
      chr: 'chr7',
      chrLength: 159_345_973,
      widthPx: 800,
      centerBp: 5_530_600,
      bpPerPx: 0.25,
      range: {
        start: 5_530_500,
        end: 5_530_700,
        span: 200,
      },
    };

    const result = deriveTrackWindowSpec(stableComputationalTrack, baseViewport, baseSpec);

    expect(result.requestEnd - result.requestStart).toBe(1_364);
    expect(baseViewport.range.start - result.requestStart).toBeGreaterThanOrEqual(325);
    expect(result.requestEnd - baseViewport.range.end).toBeGreaterThanOrEqual(325);
  });

  it('hands a stable-margin viewport to the exact prefetched window only near its safe edge', () => {
    const baseViewport: ViewportState = {
      chr: 'chr7',
      chrLength: 159_345_973,
      widthPx: 800,
      centerBp: 5_530_600,
      bpPerPx: 0.25,
      range: {
        start: 5_530_500,
        end: 5_530_700,
        span: 200,
      },
    };
    const current = deriveTrackWindowSpec(stableComputationalTrack, baseViewport, baseSpec);
    const rightNeighbor = deriveComputationalNeighborSpecs(
      stableComputationalTrack,
      baseViewport,
      current,
    ).find((neighbor) => neighbor.requestStart > current.requestStart);
    expect(rightNeighbor).toBeDefined();

    const panBy = (delta: number): ViewportState => ({
      ...baseViewport,
      centerBp: baseViewport.centerBp + delta,
      range: {
        start: baseViewport.range.start + delta,
        end: baseViewport.range.end + delta,
        span: baseViewport.range.span,
      },
    });
    let firstHandoffBp: number | undefined;
    for (let delta = 1; delta <= 2_000; delta += 1) {
      const panned = deriveTrackWindowSpec(stableComputationalTrack, panBy(delta), baseSpec);
      if (panned.requestStart !== current.requestStart) {
        firstHandoffBp = delta;
        expect(panned).toEqual(expect.objectContaining({
          requestStart: rightNeighbor?.requestStart,
          requestEnd: rightNeighbor?.requestEnd,
        }));
        break;
      }
    }

    expect(firstHandoffBp).toBeDefined();
    expect(firstHandoffBp).toBeGreaterThan(1);
    const beforeHandoff = panBy((firstHandoffBp as number) - 1);
    expect(deriveTrackWindowSpec(stableComputationalTrack, beforeHandoff, baseSpec)).toEqual(current);
    expect(current.requestEnd - beforeHandoff.range.end).toBeGreaterThanOrEqual(325);
    expect(current.requestEnd - panBy(firstHandoffBp as number).range.end).toBeLessThanOrEqual(326);
  });

  it('reduces the stable margin symmetrically when the model budget cannot fit it', () => {
    recordInferenceCalibration('/computational/models/seqbro2-puffin.onnx', 0.1);
    const cappedViewport: ViewportState = {
      chr: 'chr7',
      chrLength: 159_345_973,
      widthPx: 1_000,
      centerBp: 5_530_600,
      bpPerPx: 4.6,
      range: {
        start: 5_528_300,
        end: 5_532_900,
        span: 4_600,
      },
    };

    const result = deriveTrackWindowSpec(stableComputationalTrack, cappedViewport, baseSpec);
    const leftMargin = cappedViewport.range.start - result.requestStart;
    const rightMargin = result.requestEnd - cappedViewport.range.end;

    expect(result.requestEnd - result.requestStart).toBe(5_000);
    expect(result.requestStart).toBeLessThanOrEqual(cappedViewport.range.start);
    expect(result.requestEnd).toBeGreaterThanOrEqual(cappedViewport.range.end);
    expect(leftMargin).toBeGreaterThanOrEqual(199);
    expect(rightMargin).toBeGreaterThanOrEqual(199);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);
  });

  it('uses the chromosome boundary when a full stable margin is impossible there', () => {
    const edgeViewport: ViewportState = {
      chr: 'chr7',
      chrLength: 159_345_973,
      widthPx: 800,
      centerBp: 100,
      bpPerPx: 0.25,
      range: {
        start: 0,
        end: 200,
        span: 200,
      },
    };

    const result = deriveTrackWindowSpec(stableComputationalTrack, edgeViewport, baseSpec);
    expect(result.requestStart).toBe(0);
    expect(result.requestEnd - edgeViewport.range.end).toBeGreaterThanOrEqual(325);
  });

  it('always keeps the computational request covering the viewport while panning', () => {
    const panDeltas = [0, 5_000, 10_000, 15_000, 20_000];
    for (const delta of panDeltas) {
      const pannedViewport: ViewportState = {
        ...viewport,
        centerBp: viewport.centerBp + delta,
        range: {
          start: viewport.range.start + delta,
          end: viewport.range.end + delta,
          span: viewport.range.span,
        },
      };
      const spec = deriveTrackWindowSpec(computationalTrack, pannedViewport, baseSpec);
      expect(spec.requestStart).toBeLessThanOrEqual(pannedViewport.range.start);
      expect(spec.requestEnd).toBeGreaterThanOrEqual(pannedViewport.range.end);
    }
  });

  it('keeps computational request identity stable across resolution changes', () => {
    const coarseBaseSpec: DataWindowSpec = {
      ...baseSpec,
      key: 'chr1:124000000:124200000:r20',
      resolutionBp: 20,
    };
    const fine = deriveTrackWindowSpec(computationalTrack, viewport, baseSpec);
    const coarse = deriveTrackWindowSpec(computationalTrack, viewport, coarseBaseSpec);

    expect(fine.requestStart).toBe(coarse.requestStart);
    expect(fine.requestEnd).toBe(coarse.requestEnd);
    expect(fine.key).toBe(coarse.key);
    expect(fine.resolutionBp).not.toBe(coarse.resolutionBp);
  });
});
