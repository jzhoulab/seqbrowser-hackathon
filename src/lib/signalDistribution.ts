/**
 * Weighted value distribution for a signal track, used to answer "is this region
 * high or low?" — a question local auto-scaling actively hides.
 *
 * Derived from bigWig zoom (summary) records. Three properties of that format
 * drive the design, all verified against the UCSC source (kent/src/lib/bbiWrite.c):
 *
 * 1. `sumData` is a sum over BASES (`(end-start) * value`), and `validCount` counts
 *    bases with data — so `sumData / validCount` is an exact per-base mean.
 * 2. Zoom levels are built hierarchically from the previous level, and min/max/sum
 *    aggregate associatively, so these statistics are exact rather than lossy.
 * 3. Summary bins are NOT grid-aligned. They chain contiguously from wherever data
 *    begins and only break after a gap, so bins have unequal spans and coverage.
 *    Quantiles must therefore be weighted by `validCount`; treating each record as
 *    one equal sample skews them badly (measured 2x at p90 on ENCODE H3K27ac).
 *
 * Because bin size determines the statistic, a distribution is only meaningful
 * alongside the bin size it was built at, and is only comparable to rendered values
 * binned the same way. Callers must build it at the zoom level being rendered.
 */

/** Number of steps in the quantile ladder; index i holds the value at i/LADDER_STEPS. */
export const LADDER_STEPS = 256;

export type WeightedSample = {
  value: number;
  /** Bases of real data behind this sample (bigWig `validCount`). */
  weight: number;
};

export type SignalDistribution = {
  /** Per-bin means across the chromosome, in genomic order. */
  binValues: Float32Array;
  /** Bases of real data behind each bin, index-aligned with `binValues`. */
  binWeights: Float32Array;
  /** Bin start coordinates, index-aligned. Bins are not grid-aligned or uniform. */
  binStarts: Int32Array;
  /** Bin end coordinates, index-aligned. */
  binEnds: Int32Array;
  /** Bin size (bigWig reductionLevel) this was built at. */
  binSizeBp: number;
  /** Total bases of real data behind the distribution. */
  coveredBases: number;
  minValue: number;
  maxValue: number;
  /** Exact per-base mean across the covered bases. */
  meanValue: number;
};

/**
 * Fewer comparable windows than this and a percentile is not worth quoting — at
 * whole-chromosome spans there are only a handful of same-sized windows to rank against.
 */
export const MIN_COMPARABLE_WINDOWS = 60;

/**
 * Distribution of the per-base mean within each non-overlapping window of
 * `windowBins` bins, across the chromosome.
 *
 * Why the mean and not the peak: a maximum is not comparable across resolutions.
 * The max of N draws is almost always extreme for a single draw, so ranking a view's
 * peak against single bins puts essentially every region in the top percentile — and
 * the browser renders raw per-base values when zoomed in past the finest zoom level,
 * which no chromosome-wide reference can match. A per-base mean is resolution-
 * independent by construction: the mean over a span is the same number whether it is
 * computed from raw bases or aggregated bins. That makes this rank valid at any zoom.
 *
 * Returns null when there are too few windows to rank meaningfully.
 */
export function buildWindowMeanLadder(
  binValues: Float32Array,
  binWeights: Float32Array,
  windowBins: number,
): Float32Array | null {
  const width = Math.max(1, Math.floor(windowBins));
  const windowCount = Math.floor(binValues.length / width);
  if (windowCount < MIN_COMPARABLE_WINDOWS) {
    return null;
  }

  const samples: WeightedSample[] = [];
  for (let window = 0; window < windowCount; window += 1) {
    const start = window * width;
    const end = start + width;
    let weightedSum = 0;
    let weight = 0;
    for (let index = start; index < end; index += 1) {
      const binWeight = binWeights[index];
      if (binWeight > 0) {
        weight += binWeight;
        weightedSum += binValues[index] * binWeight;
      }
    }
    if (weight > 0) {
      samples.push({ value: weightedSum / weight, weight });
    }
  }

  if (samples.length < MIN_COMPARABLE_WINDOWS) {
    return null;
  }
  return buildQuantileLadder(samples);
}

/**
 * Exact per-base mean over a genomic interval, from the chromosome-wide bins.
 *
 * Computed from the summary records rather than from the rendered features so it is
 * identical regardless of the resolution currently on screen — which is what makes it
 * comparable to `buildWindowMeanLadder`. Bins are not uniform, so overlap is measured
 * per bin rather than assumed.
 */
export function regionMean(
  distribution: Pick<SignalDistribution, 'binValues' | 'binWeights' | 'binStarts' | 'binEnds'>,
  startBp: number,
  endBp: number,
): number {
  const { binValues, binWeights, binStarts, binEnds } = distribution;
  if (binValues.length === 0 || !(endBp > startBp)) {
    return Number.NaN;
  }

  // Bins are sorted by start, so binary search the first that could overlap.
  let low = 0;
  let high = binStarts.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (binEnds[mid] <= startBp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let weightedSum = 0;
  let weight = 0;
  for (let index = low; index < binValues.length && binStarts[index] < endBp; index += 1) {
    const span = binEnds[index] - binStarts[index];
    if (span <= 0 || binWeights[index] <= 0) {
      continue;
    }
    const overlap = Math.min(binEnds[index], endBp) - Math.max(binStarts[index], startBp);
    if (overlap <= 0) {
      continue;
    }
    // Apportion the bin's covered bases by how much of it the view actually sees.
    const share = (overlap / span) * binWeights[index];
    weightedSum += binValues[index] * share;
    weight += share;
  }

  return weight > 0 ? weightedSum / weight : Number.NaN;
}

/**
 * Build a weight-aware quantile ladder. Weighting is the whole point: bigWig summary
 * bins cover wildly different numbers of bases, so an unweighted quantile answers
 * "the typical bin" when the user is asking about "the typical base".
 */
export function buildQuantileLadder(samples: WeightedSample[], steps = LADDER_STEPS): Float32Array {
  const ladder = new Float32Array(steps + 1);
  const usable = samples.filter(
    (sample) => Number.isFinite(sample.value) && Number.isFinite(sample.weight) && sample.weight > 0,
  );
  if (usable.length === 0) {
    return ladder;
  }

  const sorted = usable.slice().sort((left, right) => left.value - right.value);
  let totalWeight = 0;
  for (const sample of sorted) {
    totalWeight += sample.weight;
  }
  if (totalWeight <= 0) {
    return ladder;
  }

  let index = 0;
  let cumulative = sorted[0].weight;
  for (let step = 0; step <= steps; step += 1) {
    const target = (step / steps) * totalWeight;
    while (cumulative < target && index < sorted.length - 1) {
      index += 1;
      cumulative += sorted[index].weight;
    }
    ladder[step] = sorted[index].value;
  }

  return ladder;
}

/**
 * Fraction of weight (bases) at or below `value`, in [0, 1]. Interpolates between
 * ladder steps so the readout moves smoothly rather than snapping between percentiles.
 *
 * Returns NaN when the distribution has no spread — an empty ladder, or a track whose
 * every base holds the same value. A rank is genuinely undefined there, and returning
 * 1 would render as "top 0.1%" on a flat track.
 */
export function percentileOfValue(ladder: Float32Array, value: number): number {
  const steps = ladder.length - 1;
  if (steps <= 0 || !Number.isFinite(value)) {
    return Number.NaN;
  }
  if (!(ladder[steps] > ladder[0])) {
    return Number.NaN;
  }
  if (value <= ladder[0]) {
    return 0;
  }
  if (value >= ladder[steps]) {
    return 1;
  }

  let low = 0;
  let high = steps;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (ladder[mid] <= value) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const spanValue = ladder[high] - ladder[low];
  const withinStep = spanValue > 0 ? (value - ladder[low]) / spanValue : 0;
  return (low + withinStep) / steps;
}

export function valueAtPercentile(ladder: Float32Array, percentile: number): number {
  const steps = ladder.length - 1;
  if (steps <= 0) {
    return 0;
  }
  const clamped = Math.min(1, Math.max(0, percentile));
  const position = clamped * steps;
  const low = Math.floor(position);
  const high = Math.min(steps, low + 1);
  const fraction = position - low;
  return ladder[low] + (ladder[high] - ladder[low]) * fraction;
}

/**
 * Human-facing rank label. Deliberately coarse at the top end: past ~p99 the exact
 * figure is noise, but "top 0.1%" is the part users actually act on.
 */
export function formatPercentile(percentile: number): string {
  if (!Number.isFinite(percentile)) {
    return '--';
  }
  const clamped = Math.min(1, Math.max(0, percentile));
  if (clamped >= 0.999) {
    return 'top 0.1%';
  }
  if (clamped >= 0.99) {
    return 'top 1%';
  }
  if (clamped >= 0.95) {
    return 'top 5%';
  }
  const rank = Math.round(clamped * 100);
  return `p${Math.max(1, rank)}`;
}
