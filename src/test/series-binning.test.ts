import { describe, expect, it } from 'vitest';

import { seriesToBinnedFeatures } from '../lib/seriesBinning';

/** One base at `peakIndex` scores 1, everything else scores ~0. */
function spikeAt(length: number, peakIndex: number, peak = 1): Float32Array {
  const values = new Float32Array(length);
  values.fill(0.01);
  values[peakIndex] = peak;
  return values;
}

describe('per-base score binning', () => {
  it('keeps a single-base peak at full height when binning down', () => {
    const values = spikeAt(1_000, 500);

    for (const resolutionBp of [1, 5, 25, 100]) {
      const features = seriesToBinnedFeatures(values, 0, 1_000, resolutionBp);
      const tallest = Math.max(...features.map((feature) => feature.score));
      expect(tallest, `resolution ${resolutionBp}`).toBeCloseTo(1, 5);
    }
  });

  it('reports the same peak height at every zoom level', () => {
    const values = spikeAt(2_000, 1_234, 0.87);
    const heights = [1, 10, 50, 200].map((resolutionBp) =>
      Math.max(...seriesToBinnedFeatures(values, 0, 2_000, resolutionBp).map((f) => f.score)),
    );

    expect(new Set(heights.map((height) => height.toFixed(5))).size).toBe(1);
  });

  it('leaves the peak in the bin that contains it', () => {
    const features = seriesToBinnedFeatures(spikeAt(1_000, 500), 0, 1_000, 100);
    const peak = features.find((feature) => feature.score > 0.5);

    expect(peak?.start).toBe(500);
    expect(peak?.end).toBe(600);
  });

  it('keeps the direction of a signed output', () => {
    const values = new Float32Array([0.1, -0.9, 0.2, 0.3]);
    const [binned] = seriesToBinnedFeatures(values, 0, 4, 4);

    expect(binned.score).toBeCloseTo(-0.9, 5);
  });

  it('covers the requested window exactly once', () => {
    const features = seriesToBinnedFeatures(new Float32Array(300).fill(0.5), 1_000, 1_300, 100);

    expect(features).toHaveLength(3);
    expect(features[0].start).toBe(1_000);
    expect(features[features.length - 1].end).toBe(1_300);
    expect(features.every((feature) => feature.score === 0.5)).toBe(true);
  });

  it('assigns every sample to exactly one bin at fractional bin sizes', () => {
    // 1000 samples over 334 bins is 2.994 samples each. Rounding a bin's end sample
    // up would hand the boundary sample to this bin *and* the next, so a peak
    // sitting on one would surface twice -- one site drawn as an adjacent pair
    // with an identical score, which is what this guards against.
    for (const resolutionBp of [2, 3, 7, 13, 60]) {
      for (const peakIndex of [2, 5, 17, 101, 499, 998]) {
        const features = seriesToBinnedFeatures(spikeAt(1_000, peakIndex, 0.93), 0, 1_000, resolutionBp);
        const carrying = features.filter((feature) => feature.score > 0.5);

        expect(carrying, `peak ${peakIndex} at resolution ${resolutionBp}`).toHaveLength(1);
      }
    }
  });

  it('never draws one sample as two adjacent bins', () => {
    // A covered window that rounds out one base wider than the sample count: the
    // peak must stay a single feature, not a duplicated pair.
    const values = spikeAt(10, 4, 0.9);
    const features = seriesToBinnedFeatures(values, 1_000, 1_011, 1);

    expect(features).toHaveLength(values.length);
    expect(features.filter((feature) => feature.score > 0.5)).toHaveLength(1);
  });

  it('covers the window without gaps when samples are coarser than bins', () => {
    const features = seriesToBinnedFeatures(new Float32Array(4).fill(1), 0, 9, 1);

    expect(features[0].start).toBe(0);
    expect(features[features.length - 1].end).toBe(9);
    for (let index = 1; index < features.length; index += 1) {
      expect(features[index].start).toBeCloseTo(features[index - 1].end, 6);
    }
  });

  it('tags every bin with the series it came from', () => {
    const features = seriesToBinnedFeatures(new Float32Array(10).fill(1), 0, 10, 5, 3);

    expect(features.every((feature) => feature.seriesIndex === 3)).toBe(true);
  });

  it('survives non-finite model output', () => {
    const values = new Float32Array([Number.NaN, Number.NaN]);
    const [binned] = seriesToBinnedFeatures(values, 0, 2, 2);

    expect(binned.score).toBe(0);
  });
});
