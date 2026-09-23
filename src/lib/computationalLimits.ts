import type { ComputationalPackManifest } from '../types';

export const FALLBACK_COMPUTATIONAL_MAX_WINDOW_BP = 300_000;
export const HARD_COMPUTATIONAL_MAX_SEQUENCE_BP = 320_000;

/**
 * Product constraint: a single inference must stay interactive. The window a
 * model is allowed to compute is derived from this budget divided by the model's
 * measured cost, not from a fixed base-pair count — cost per base varies ~80x
 * across models and also depends on the device, so no static number can hold.
 */
export const INFERENCE_BUDGET_MS = 1_000;

// Extra head-room applied to the measured cost, so the real window (which can be a
// little slower than the synthetic probe) still lands under budget.
const INFERENCE_COST_SAFETY = 1.25;

// Smallest window we will ever offer to compute. Below this the model is too slow
// on this device to be worth running; gating just keeps asking the user to zoom in.
const MIN_BUDGETED_WINDOW_BP = 256;

// Until a model has been calibrated on this device we assume it is expensive, so a
// large inference cannot fire before warm-up calibration (run at import) lands.
const UNCALIBRATED_MS_PER_BP = 1;

const costByModel = new Map<string, number>();
let costVersion = 0;
const listeners = new Set<() => void>();

function notifyCostListeners(): void {
  costVersion += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe to calibration changes (for `useSyncExternalStore`). */
export function subscribeInferenceCost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getInferenceCostVersion(): number {
  return costVersion;
}

/**
 * Record a device-measured cost for a model, in milliseconds per input base pair.
 * Keyed by the raw `pack.model.url` so the worker and the main thread agree on the
 * cap. `notify: false` updates the number without forcing a re-render, for refining
 * measurements taken mid-interaction.
 */
export function recordInferenceCalibration(
  modelUrl: string,
  msPerBp: number,
  { notify = true }: { notify?: boolean } = {},
): void {
  if (!Number.isFinite(msPerBp) || msPerBp <= 0) {
    return;
  }
  costByModel.set(modelUrl, msPerBp);
  if (notify) {
    notifyCostListeners();
  }
}

export function getInferenceMsPerBp(modelUrl: string): number | undefined {
  return costByModel.get(modelUrl);
}

/** For tests: forget all measured costs. */
export function resetInferenceCalibration(): void {
  costByModel.clear();
  notifyCostListeners();
}

/** The pack-declared cap, ignoring device cost. */
export function declaredComputationalMaxWindowBp(pack: ComputationalPackManifest): number {
  const configured = pack.inference?.maxWindowBp;
  if (!configured || !Number.isFinite(configured)) {
    return FALLBACK_COMPUTATIONAL_MAX_WINDOW_BP;
  }
  return Math.max(1, Math.min(Math.floor(configured), FALLBACK_COMPUTATIONAL_MAX_WINDOW_BP));
}

/**
 * Snap a window size to a coarse 1-2-5 grid, so small changes in a measured cost
 * do not churn the cap (and the cache keys derived from it) on every frame.
 */
function quantizeWindowBp(bp: number): number {
  if (bp <= MIN_BUDGETED_WINDOW_BP) {
    return MIN_BUDGETED_WINDOW_BP;
  }
  const pow = 10 ** Math.floor(Math.log10(bp));
  const frac = bp / pow;
  const step = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  return step * pow;
}

/**
 * Largest window this model may compute right now: the smaller of the pack's
 * declared cap and the window that fits the latency budget at the model's measured
 * (or, pre-calibration, assumed) cost.
 */
export function effectiveComputationalMaxWindowBp(pack: ComputationalPackManifest): number {
  const declared = declaredComputationalMaxWindowBp(pack);
  const measured = getInferenceMsPerBp(pack.model.url);
  const msPerBp = (measured ?? UNCALIBRATED_MS_PER_BP) * INFERENCE_COST_SAFETY;
  const budgetedBp = quantizeWindowBp(Math.floor(INFERENCE_BUDGET_MS / msPerBp));
  return Math.max(MIN_BUDGETED_WINDOW_BP, Math.min(declared, budgetedBp));
}
