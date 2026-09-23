export type TrackLoadState = 'loading' | 'ready' | 'empty' | 'failed';
export type GlobalLoadState = TrackLoadState | 'mixed';

export interface TrackLoadSignal {
  loading?: boolean;
  error?: unknown;
  featureCount?: number | null;
}

export interface GlobalLoadStateSummary {
  state: GlobalLoadState;
  hasPartialFailure: boolean;
  counts: Record<TrackLoadState, number>;
}

function createEmptyCounts(): Record<TrackLoadState, number> {
  return {
    loading: 0,
    ready: 0,
    empty: 0,
    failed: 0,
  };
}

function isFeatureCountReady(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function classifyTrackLoadState(signal: TrackLoadSignal): TrackLoadState {
  if (signal.loading) {
    return 'loading';
  }

  if (signal.error != null) {
    return 'failed';
  }

  return isFeatureCountReady(signal.featureCount) ? 'ready' : 'empty';
}

export function hasPartialFailure(states: readonly TrackLoadState[]): boolean {
  let hasReady = false;
  let hasFailed = false;

  for (const state of states) {
    if (state === 'ready') {
      hasReady = true;
    } else if (state === 'failed') {
      hasFailed = true;
    }

    if (hasReady && hasFailed) {
      return true;
    }
  }

  return false;
}

function classifyHomogeneousState(
  counts: Record<TrackLoadState, number>,
  totalCount: number,
): TrackLoadState | null {
  if (totalCount === 0) {
    return 'empty';
  }

  if (counts.loading === totalCount) {
    return 'loading';
  }
  if (counts.ready === totalCount) {
    return 'ready';
  }
  if (counts.empty === totalCount) {
    return 'empty';
  }
  if (counts.failed === totalCount) {
    return 'failed';
  }

  return null;
}

export function deriveGlobalLoadState(states: readonly TrackLoadState[]): GlobalLoadStateSummary {
  const counts = createEmptyCounts();
  for (const state of states) {
    counts[state] += 1;
  }

  const homogeneous = classifyHomogeneousState(counts, states.length);
  return {
    state: homogeneous ?? 'mixed',
    hasPartialFailure: hasPartialFailure(states),
    counts,
  };
}
