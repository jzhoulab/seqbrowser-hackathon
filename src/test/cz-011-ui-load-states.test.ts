import { describe, expect, it } from 'vitest';

import {
  classifyTrackLoadState,
  deriveGlobalLoadState,
  hasPartialFailure,
  type TrackLoadState,
} from '../features/ui/loadStates';

describe('CZ-011 per-track load state classifier', () => {
  it('classifies loading, failed, ready, and empty track states', () => {
    expect(classifyTrackLoadState({ loading: true })).toBe('loading');
    expect(classifyTrackLoadState({ error: 'network timeout' })).toBe('failed');
    expect(classifyTrackLoadState({ featureCount: 12 })).toBe('ready');
    expect(classifyTrackLoadState({ featureCount: 0 })).toBe('empty');
  });
});

describe('CZ-011 global load state classifier', () => {
  it('derives homogeneous global states from per-track states', () => {
    expect(deriveGlobalLoadState(['loading', 'loading']).state).toBe('loading');
    expect(deriveGlobalLoadState(['ready', 'ready']).state).toBe('ready');
    expect(deriveGlobalLoadState(['empty', 'empty']).state).toBe('empty');
    expect(deriveGlobalLoadState(['failed', 'failed']).state).toBe('failed');
  });

  it('returns mixed when per-track states are mixed', () => {
    const states: TrackLoadState[] = ['loading', 'ready', 'empty'];

    expect(deriveGlobalLoadState(states)).toEqual({
      state: 'mixed',
      hasPartialFailure: false,
      counts: {
        loading: 1,
        ready: 1,
        empty: 1,
        failed: 0,
      },
    });
  });

  it('detects partial failure when some tracks are ready and others fail', () => {
    const states: TrackLoadState[] = ['ready', 'failed', 'failed'];

    expect(hasPartialFailure(states)).toBe(true);
    expect(deriveGlobalLoadState(states)).toEqual({
      state: 'mixed',
      hasPartialFailure: true,
      counts: {
        loading: 0,
        ready: 1,
        empty: 0,
        failed: 2,
      },
    });
  });
});
