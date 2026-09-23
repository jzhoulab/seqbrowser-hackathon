import { describe, expect, it } from 'vitest';
import { seriesToBinnedFeatures } from '../lib/seriesBinning';

// Found by comparing the worker's output for a real 4,000-base window against
// the model run outside the browser: bins 1001, 1005 and 2006 carried the value
// of the base before them. The bin-to-sample mapping went through a fractional
// base-pair position and back, and (bin / binCount) * span / span * samples is
// not always bin. A per-base model output must come back as exactly itself.

describe('seriesToBinnedFeatures at one sample per bin', () => {
  it('maps every sample to its own bin, for every length a window can have', () => {
    for (const length of [1000, 2000, 3000, 4000, 4096, 5830, 6000, 7000]) {
      const values = Float32Array.from({ length }, (_, index) => index);
      const startBp = 5_526_700;
      const features = seriesToBinnedFeatures(values, startBp, startBp + length, 1);
      expect(features).toHaveLength(length);
      features.forEach((feature, index) => {
        expect(feature.score, `length ${length}, bin ${index}`).toBe(index);
        expect(feature.start).toBe(startBp + index);
        expect(feature.end).toBe(startBp + index + 1);
      });
    }
  });

  it('at a coarser resolution each bin covers a distinct run of samples and keeps its most extreme value', () => {
    const values = new Float32Array(4000);
    values[1004] = 0.9;   // a single-base call
    values[1005] = -0.2;
    const features = seriesToBinnedFeatures(values, 0, 4000, 2);
    expect(features).toHaveLength(2000);
    expect(features[502]!.score).toBeCloseTo(0.9, 6);      // samples 1004-1005: magnitude wins
    expect(features[501]!.score).toBe(0);
    expect(features[503]!.score).toBe(0);
    expect(features.filter((feature) => feature.score !== 0)).toHaveLength(1);
  });
});
