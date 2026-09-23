import { clamp } from '../../lib/genomeMath';
import type { TrackLoadState } from './loadStates';

export type ScrollBackpressureSample = {
  loadState: TrackLoadState;
  sourceType: 'computational' | 'standard';
};

export type ScrollBackpressure = {
  panDamping: number;
  loadingRatio: number;
  showIndicator: boolean;
  mode: 'computing' | 'loading';
  slowdownPercent: number;
  loadingCount: number;
};

const COMPUTATIONAL_WEIGHT = 1.8;
const FAILED_PRESSURE_WEIGHT = 0.35;
const DAMPING_START_RATIO = 0.14;
const MIN_PAN_DAMPING = 0.24;
const INDICATOR_SHOW_RATIO = 0.28;

export function deriveScrollBackpressure(
  samples: readonly ScrollBackpressureSample[],
): ScrollBackpressure {
  if (samples.length === 0) {
    return {
      panDamping: 1,
      loadingRatio: 0,
      showIndicator: false,
      mode: 'loading',
      slowdownPercent: 0,
      loadingCount: 0,
    };
  }

  let totalWeight = 0;
  let pressureWeight = 0;
  let loadingCount = 0;
  let hasComputationalLoading = false;

  for (const sample of samples) {
    const weight = sample.sourceType === 'computational' ? COMPUTATIONAL_WEIGHT : 1;
    totalWeight += weight;

    if (sample.loadState === 'loading') {
      pressureWeight += weight;
      loadingCount += 1;
      if (sample.sourceType === 'computational') {
        hasComputationalLoading = true;
      }
      continue;
    }

    if (sample.loadState === 'failed') {
      pressureWeight += weight * FAILED_PRESSURE_WEIGHT;
    }
  }

  const loadingRatio = totalWeight > 0 ? clamp(pressureWeight / totalWeight, 0, 1) : 0;
  const normalizedPressure = clamp(
    (loadingRatio - DAMPING_START_RATIO) / (1 - DAMPING_START_RATIO),
    0,
    1,
  );
  const panDamping = clamp(1 - normalizedPressure * (1 - MIN_PAN_DAMPING), MIN_PAN_DAMPING, 1);

  return {
    panDamping,
    loadingRatio,
    showIndicator: loadingCount > 0 && loadingRatio >= INDICATOR_SHOW_RATIO,
    mode: hasComputationalLoading ? 'computing' : 'loading',
    slowdownPercent: Math.round((1 - panDamping) * 100),
    loadingCount,
  };
}
