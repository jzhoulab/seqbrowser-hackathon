import { describe, expect, it } from 'vitest';
import {
  buildQuantileLadder,
  buildWindowMeanLadder,
  regionMean,
  formatPercentile,
  percentileOfValue,
  valueAtPercentile,
  type WeightedSample,
} from '../lib/signalDistribution';

describe('buildQuantileLadder', () => {
  it('weights by bases, not by record count', () => {
    // The bug this guards: bigWig summary bins cover unequal numbers of bases, so
    // counting each record once answers a different question than the user asked.
    // Here 99 tiny low bins carry 99 bases total; one bin carries 9,901 high bases.
    // By record count the median is ~1; by base coverage it is 100.
    const samples: WeightedSample[] = [
      ...Array.from({ length: 99 }, () => ({ value: 1, weight: 1 })),
      { value: 100, weight: 9_901 },
    ];

    const ladder = buildQuantileLadder(samples);
    expect(valueAtPercentile(ladder, 0.5)).toBe(100);

    const unweighted = buildQuantileLadder(samples.map((s) => ({ value: s.value, weight: 1 })));
    expect(valueAtPercentile(unweighted, 0.5)).toBe(1);
  });

  it('ignores zero, negative, and non-finite weights', () => {
    const ladder = buildQuantileLadder([
      { value: 5, weight: 10 },
      { value: 1_000, weight: 0 },
      { value: 2_000, weight: -4 },
      { value: 3_000, weight: Number.NaN },
    ]);
    expect(valueAtPercentile(ladder, 0)).toBe(5);
    expect(valueAtPercentile(ladder, 1)).toBe(5);
  });

  it('returns an all-zero ladder for empty input rather than throwing', () => {
    const ladder = buildQuantileLadder([]);
    expect(ladder.length).toBe(257);
    // Not 0 and emphatically not 1: an empty distribution has no rank, and
    // reporting 1 would render a flat track as "top 0.1%".
    expect(percentileOfValue(ladder, 42)).toBeNaN();
    expect(formatPercentile(percentileOfValue(ladder, 42))).toBe('--');
  });

  it('reports no rank for a track with no spread', () => {
    const flat = buildQuantileLadder(Array.from({ length: 50 }, () => ({ value: 7, weight: 100 })));
    expect(percentileOfValue(flat, 7)).toBeNaN();
    expect(percentileOfValue(flat, 900)).toBeNaN();
  });

  it('spans min to max across the ladder', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ value: i, weight: 1 }));
    const ladder = buildQuantileLadder(samples);
    expect(ladder[0]).toBe(0);
    expect(ladder[ladder.length - 1]).toBe(99);
  });
});

describe('percentileOfValue', () => {
  const ladder = buildQuantileLadder(
    Array.from({ length: 1_000 }, (_, i) => ({ value: i, weight: 1 })),
  );

  it('clamps below the minimum and above the maximum', () => {
    expect(percentileOfValue(ladder, -50)).toBe(0);
    expect(percentileOfValue(ladder, 10_000)).toBe(1);
  });

  it('ranks a mid value near the middle', () => {
    expect(percentileOfValue(ladder, 500)).toBeGreaterThan(0.45);
    expect(percentileOfValue(ladder, 500)).toBeLessThan(0.55);
  });

  it('is monotonic', () => {
    let previous = -1;
    for (const value of [0, 100, 250, 500, 750, 900, 999]) {
      const p = percentileOfValue(ladder, value);
      expect(p).toBeGreaterThanOrEqual(previous);
      previous = p;
    }
  });

  it('places a heavy-tail peak in the top percentiles', () => {
    // Shape of real ChIP-seq: almost everything near zero, a thin high tail.
    const samples: WeightedSample[] = [
      ...Array.from({ length: 990 }, () => ({ value: 1.2, weight: 1_000 })),
      ...Array.from({ length: 10 }, (_, i) => ({ value: 50 + i * 20, weight: 100 })),
    ];
    const ladder = buildQuantileLadder(samples);
    expect(percentileOfValue(ladder, 183)).toBeGreaterThan(0.99);
    expect(percentileOfValue(ladder, 1.2)).toBeLessThan(0.999);
  });
});

describe('formatPercentile', () => {
  it('collapses the noisy top end into actionable buckets', () => {
    expect(formatPercentile(0.9995)).toBe('top 0.1%');
    expect(formatPercentile(0.995)).toBe('top 1%');
    expect(formatPercentile(0.97)).toBe('top 5%');
    expect(formatPercentile(0.5)).toBe('p50');
  });
});

describe('buildWindowMeanLadder', () => {
  // A chromosome that is mostly quiet with periodic hot stretches.
  function syntheticChromosome(bins: number, spikeEvery = 500) {
    const values = new Float32Array(bins);
    const weights = new Float32Array(bins);
    for (let i = 0; i < bins; i += 1) {
      values[i] = i % spikeEvery === 0 ? 100 : 1;
      weights[i] = 1_000;
    }
    return { values, weights };
  }

  it('refuses to rank when there are too few comparable windows', () => {
    const { values, weights } = syntheticChromosome(1_000);
    // 1000 bins / 500-bin windows = 2 windows: nowhere near enough to quote a rank.
    expect(buildWindowMeanLadder(values, weights, 500)).toBeNull();
  });

  it('separates windows containing a hot stretch from quiet ones', () => {
    const { values, weights } = syntheticChromosome(20_000, 500);
    const ladder = buildWindowMeanLadder(values, weights, 100);
    expect(ladder).not.toBeNull();

    // 1 window in 5 contains a spike, lifting its mean to ~1.99; the rest sit at 1.
    const quiet = percentileOfValue(ladder!, 1);
    const hot = percentileOfValue(ladder!, 1.99);
    expect(hot).toBeGreaterThan(quiet);
    expect(hot).toBeGreaterThan(0.5);
  });

  it('is resolution-independent: aggregating bins does not move the rank', () => {
    // The property that makes a mean usable where a max is not. Merging bin pairs
    // halves the resolution but must leave every window mean, and so every rank,
    // exactly where it was.
    const bins = 20_000;
    const fine = new Float32Array(bins);
    const fineWeights = new Float32Array(bins);
    for (let i = 0; i < bins; i += 1) {
      // Deterministic pseudo-random spread so window means genuinely differ.
      fine[i] = 1 + ((i * 2_654_435_761) % 997) / 100;
      fineWeights[i] = 1_000;
    }
    const coarse = new Float32Array(bins / 2);
    const coarseWeights = new Float32Array(bins / 2);
    for (let i = 0; i < coarse.length; i += 1) {
      coarse[i] = (fine[i * 2] + fine[i * 2 + 1]) / 2;
      coarseWeights[i] = 2_000;
    }

    const fineLadder = buildWindowMeanLadder(fine, fineWeights, 200);
    const coarseLadder = buildWindowMeanLadder(coarse, coarseWeights, 100);
    expect(fineLadder).not.toBeNull();
    expect(coarseLadder).not.toBeNull();

    for (const probe of [5, 5.5, 6]) {
      const atFine = percentileOfValue(fineLadder!, probe);
      expect(Number.isFinite(atFine)).toBe(true);
      expect(percentileOfValue(coarseLadder!, probe)).toBeCloseTo(atFine, 4);
    }
  });
});

describe('regionMean', () => {
  const distribution = {
    binValues: Float32Array.from([1, 10, 100]),
    binWeights: Float32Array.from([1_000, 1_000, 1_000]),
    binStarts: Int32Array.from([0, 1_000, 2_000]),
    binEnds: Int32Array.from([1_000, 2_000, 3_000]),
  };

  it('returns the per-base mean over whole bins', () => {
    expect(regionMean(distribution, 0, 3_000)).toBeCloseTo((1 + 10 + 100) / 3, 6);
  });

  it('apportions partially covered bins by overlap', () => {
    // Half of the last bin: its weight counts half as much.
    const mean = regionMean(distribution, 2_000, 2_500);
    expect(mean).toBeCloseTo(100, 6);
    const straddle = regionMean(distribution, 1_500, 2_500);
    expect(straddle).toBeCloseTo((10 * 500 + 100 * 500) / 1_000, 6);
  });

  it('returns NaN for an empty or degenerate interval', () => {
    expect(regionMean(distribution, 500, 500)).toBeNaN();
    expect(
      regionMean(
        { binValues: new Float32Array(0), binWeights: new Float32Array(0), binStarts: new Int32Array(0), binEnds: new Int32Array(0) },
        0,
        100,
      ),
    ).toBeNaN();
  });
});
