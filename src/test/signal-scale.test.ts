import { describe, expect, it, vi } from 'vitest';

import {
  createLinkedSignalDomainRegistry,
  normalizeSignalDomain,
  unionSignalDomains,
} from '../lib/signalScale';

describe('signal scale domains', () => {
  it('normalizes reversed, collapsed, and invalid domains', () => {
    expect(normalizeSignalDomain({ min: 8, max: -2 })).toEqual({ min: -2, max: 8 });

    const collapsed = normalizeSignalDomain({ min: 4, max: 4 });
    expect(collapsed.min).toBeLessThan(4);
    expect(collapsed.max).toBeGreaterThan(4);

    expect(normalizeSignalDomain({ min: Number.NaN, max: 2 })).toEqual({ min: 0, max: 1 });
  });

  it('unions finite domains without allowing invalid values to poison the result', () => {
    expect(
      unionSignalDomains([
        { min: 1, max: 4 },
        { min: 9, max: -3 },
        { min: Number.NEGATIVE_INFINITY, max: 20 },
      ]),
    ).toEqual({ min: -3, max: 9 });
    expect(unionSignalDomains([null, undefined])).toBeNull();
  });
});

describe('linked signal domain registry', () => {
  it('publishes a stable union for one group and viewport', () => {
    const registry = createLinkedSignalDomainRegistry();
    const listener = vi.fn();
    registry.subscribe('motifs', 'chr7:1-100', listener);

    registry.register('motifs', 'chr7:1-100', 'track-a', { min: 0, max: 3 });
    registry.register('motifs', 'chr7:1-100', 'track-b', { min: -8, max: 2 });

    expect(registry.read('motifs', 'chr7:1-100')).toEqual({ min: -8, max: 3 });
    expect(registry.version('motifs', 'chr7:1-100')).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isolates viewports and updates when virtualized contributors leave', () => {
    const registry = createLinkedSignalDomainRegistry();
    const removeA = registry.register('motifs', 'view-a', 'track-a', { min: 0, max: 2 });
    registry.register('motifs', 'view-a', 'track-b', { min: -5, max: 8 });
    registry.register('motifs', 'view-b', 'track-a', { min: 100, max: 200 });

    expect(registry.read('motifs', 'view-a')).toEqual({ min: -5, max: 8 });
    expect(registry.read('motifs', 'view-b')).toEqual({ min: 100, max: 200 });

    removeA();
    expect(registry.read('motifs', 'view-a')).toEqual({ min: -5, max: 8 });
    registry.remove('motifs', 'view-a', 'track-b');
    expect(registry.read('motifs', 'view-a')).toBeNull();
  });

  it('does not notify subscribers when the aggregate domain is unchanged', () => {
    const registry = createLinkedSignalDomainRegistry();
    const listener = vi.fn();
    registry.register('g', 'v', 'outer', { min: -10, max: 10 });
    registry.subscribe('g', 'v', listener);

    registry.register('g', 'v', 'inner', { min: -1, max: 1 });

    expect(listener).not.toHaveBeenCalled();
    expect(registry.version('g', 'v')).toBe(1);
  });
});
