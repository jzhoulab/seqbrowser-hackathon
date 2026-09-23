import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackRowCanvas } from '../components/TrackRowCanvas';
import type { DataWindowSpec, TrackSpec, TrackWindowData, ViewportState } from '../types';
import type { SignalDistribution } from '../lib/signalDistribution';

// Regression guard for a panning stall.
//
// `contextRank` used to depend on `viewport.range`, so every pan frame rebuilt the
// chromosome-wide quantile ladder -- a sweep over every window on the chromosome plus
// a sort, per signal track. Measured on a production build at 1.13 bp/px that was 75
// rebuilds across 25 pan steps and ~97% dropped frames.
//
// The ladder depends only on the distribution and the window WIDTH, both constant
// while panning. This test pins that: panning must not rebuild it, but a zoom change
// (which changes the width) must.

const BIN_SIZE_BP = 1_000;
const BIN_COUNT = 4_000;

const { buildWindowMeanLadderSpy, distribution } = vi.hoisted(() => {
  const binValues = new Float32Array(4_000);
  const binWeights = new Float32Array(4_000);
  const binStarts = new Int32Array(4_000);
  const binEnds = new Int32Array(4_000);
  for (let i = 0; i < 4_000; i += 1) {
    binValues[i] = Math.abs(Math.sin(i * 0.37)) * 40;
    binWeights[i] = 1_000;
    binStarts[i] = i * 1_000;
    binEnds[i] = (i + 1) * 1_000;
  }
  return {
    buildWindowMeanLadderSpy: vi.fn(),
    distribution: {
      binValues,
      binWeights,
      binStarts,
      binEnds,
      binSizeBp: 1_000,
      coveredBases: 4_000_000,
      minValue: 0,
      maxValue: 40,
      meanValue: 20,
    } as SignalDistribution,
  };
});

vi.mock('../lib/signalDistribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/signalDistribution')>();
  buildWindowMeanLadderSpy.mockImplementation(actual.buildWindowMeanLadder);
  return { ...actual, buildWindowMeanLadder: buildWindowMeanLadderSpy };
});

vi.mock('../hooks/useSignalDistribution', () => ({
  useSignalDistribution: () => distribution,
}));

const { useTrackWindowDataMock } = vi.hoisted(() => ({ useTrackWindowDataMock: vi.fn() }));
vi.mock('../hooks/useTrackWindowData', () => ({ useTrackWindowData: useTrackWindowDataMock }));

const TRACK: TrackSpec = {
  id: 'sig-1',
  name: 'H3K27ac',
  kind: 'signal',
  color: '#f87171',
  height: 76,
  source: { type: 'bigwig', url: 'https://example.test/x.bigWig' },
};

function windowSpec(start: number, end: number): DataWindowSpec {
  return { key: `k:${start}:${end}`, requestStart: start, requestEnd: end, resolutionBp: 10 };
}

function viewportAt(start: number, span: number): ViewportState {
  return {
    chr: 'chr1',
    chrLength: BIN_COUNT * BIN_SIZE_BP,
    widthPx: 1_000,
    centerBp: start + span / 2,
    bpPerPx: span / 1_000,
    // A fresh object every time, exactly as a real pan produces.
    range: { start, end: start + span, span },
  };
}

function featuresFor(start: number, end: number): TrackWindowData {
  const features = [];
  for (let bp = start; bp < end; bp += 100) {
    features.push({ start: bp, end: bp + 100, score: 5 + (bp % 17) });
  }
  return { spec: windowSpec(start, end), features, fetchedAt: 0 };
}

beforeEach(() => {
  buildWindowMeanLadderSpy.mockClear();
  useTrackWindowDataMock.mockImplementation((_t: TrackSpec, viewport: ViewportState) => ({
    loading: false,
    error: null,
    data: featuresFor(viewport.range.start, viewport.range.end),
  }));
});

afterEach(cleanup);

describe('signal value-context ladder', () => {
  it('is not rebuilt while panning at a fixed zoom', () => {
    const span = 20_000;
    const { rerender } = render(
      <TrackRowCanvas track={TRACK} viewport={viewportAt(100_000, span)} windowSpec={windowSpec(100_000, 120_000)} genome="hg38" />,
    );
    const afterFirstRender = buildWindowMeanLadderSpy.mock.calls.length;
    expect(afterFirstRender).toBeGreaterThan(0);

    for (let step = 1; step <= 12; step += 1) {
      const start = 100_000 + step * 250;
      rerender(
        <TrackRowCanvas track={TRACK} viewport={viewportAt(start, span)} windowSpec={windowSpec(start, start + span)} genome="hg38" />,
      );
    }

    expect(buildWindowMeanLadderSpy.mock.calls.length).toBe(afterFirstRender);
  });

  it('is rebuilt when the zoom changes the comparison window width', () => {
    const { rerender } = render(
      <TrackRowCanvas track={TRACK} viewport={viewportAt(100_000, 20_000)} windowSpec={windowSpec(100_000, 120_000)} genome="hg38" />,
    );
    const before = buildWindowMeanLadderSpy.mock.calls.length;

    rerender(
      <TrackRowCanvas track={TRACK} viewport={viewportAt(100_000, 60_000)} windowSpec={windowSpec(100_000, 160_000)} genome="hg38" />,
    );

    expect(buildWindowMeanLadderSpy.mock.calls.length).toBeGreaterThan(before);
    const widths = buildWindowMeanLadderSpy.mock.calls.map((call) => call[2]);
    expect(new Set(widths).size).toBeGreaterThan(1);
  });
});
