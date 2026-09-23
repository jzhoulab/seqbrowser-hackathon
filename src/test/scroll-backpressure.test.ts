import { describe, expect, it } from 'vitest';
import { deriveScrollBackpressure } from '../features/ui/scrollBackpressure';

describe('deriveScrollBackpressure', () => {
  it('returns no pressure for ready tracks', () => {
    const result = deriveScrollBackpressure([
      { loadState: 'ready', sourceType: 'standard' },
      { loadState: 'empty', sourceType: 'computational' },
    ]);

    expect(result.panDamping).toBe(1);
    expect(result.showIndicator).toBe(false);
    expect(result.loadingRatio).toBe(0);
  });

  it('applies stronger damping when computational tracks are loading', () => {
    const result = deriveScrollBackpressure([
      { loadState: 'loading', sourceType: 'computational' },
      { loadState: 'loading', sourceType: 'standard' },
      { loadState: 'ready', sourceType: 'standard' },
    ]);

    expect(result.panDamping).toBeLessThan(0.6);
    expect(result.showIndicator).toBe(true);
    expect(result.mode).toBe('computing');
    expect(result.loadingCount).toBe(2);
  });

  it('keeps damping bounded even under full loading pressure', () => {
    const result = deriveScrollBackpressure([
      { loadState: 'loading', sourceType: 'computational' },
      { loadState: 'loading', sourceType: 'computational' },
      { loadState: 'loading', sourceType: 'standard' },
    ]);

    expect(result.panDamping).toBeGreaterThanOrEqual(0.24);
    expect(result.panDamping).toBeLessThanOrEqual(1);
    expect(result.slowdownPercent).toBeGreaterThan(0);
  });
});
