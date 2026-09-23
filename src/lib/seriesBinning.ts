import { clamp } from './genomeMath';
import type { TrackFeature } from '../types';

/**
 * Bin per-base model output down to a requested resolution.
 *
 * Bins are summarized by their most extreme value rather than their mean. These
 * are per-base scores: a splice site is a single base near 1.0 among neighbours
 * near 0, so averaging 50 bases into one pixel reports 0.02 and the peak shrinks
 * as the view widens -- the same site reading differently at two zoom levels,
 * which is worse than useless for a score people compare across loci. Magnitude
 * decides the winner so signed outputs (attribution rows) keep their direction.
 */
export function seriesToBinnedFeatures(
  values: Float32Array,
  startBp: number,
  endBp: number,
  resolutionBp: number,
  seriesIndex?: number,
): TrackFeature[] {
  // No samples, no features: a row with nothing computed (a mutagenesis row past
  // its width) shows its hint instead of a run of zeros.
  if (values.length === 0) {
    return [];
  }
  const spanBp = Math.max(1, endBp - startBp);
  const binSize = Math.max(1, Math.floor(resolutionBp));
  const valueLength = Math.max(1, values.length);
  // Never emit more bins than the model emitted samples. Asking for 1 bp bins
  // across a span that rounded out one base wider than the sample count would
  // otherwise map one sample into two neighbouring bins, drawing a single site
  // as an adjacent identical pair.
  const binCount = Math.max(1, Math.min(Math.ceil(spanBp / binSize), valueLength));
  const features: TrackFeature[] = [];

  for (let bin = 0; bin < binCount; bin += 1) {
    // Bin bounds come from the bin's share of the window, so when samples are the
    // limiting factor each feature still covers exactly the base pairs it speaks for.
    const binStart = startBp + (bin * spanBp) / binCount;
    const binEnd = Math.min(endBp, startBp + ((bin + 1) * spanBp) / binCount);
    // The sample range is the bin's share of the samples, in integer arithmetic.
    // Both edges floor, so the bins partition the samples instead of overlapping.
    // This used to go through the bin's fractional base-pair position and back:
    // (bin / binCount) * span / span * samples, which for some bins lands a hair
    // below the integer and floors onto the previous sample -- bin 1001 of 4000
    // reading sample 1000, so a single-base splice call was reported at two
    // adjacent bases. Verified against the model's own output; a whole ML
    // pipeline can be exact and still be undone by one float round trip.
    const from = clamp(Math.floor((bin * valueLength) / binCount), 0, valueLength - 1);
    const toExclusive = clamp(Math.floor(((bin + 1) * valueLength) / binCount), from + 1, valueLength);

    // Summarize a bin by its most extreme value, not its mean. These are per-base
    // model scores: a splice site is one base at ~1.0 among neighbours at ~0, so
    // averaging 50 bases into a pixel reports 0.02 and the peak visibly shrinks as
    // the view widens -- the same site reading differently at two zoom levels.
    // Magnitude rather than raw max so signed outputs keep their direction.
    let extreme = 0;
    let magnitude = -1;
    for (let index = from; index < toExclusive; index += 1) {
      const value = values[index] ?? 0;
      if (!Number.isFinite(value)) {
        continue;
      }
      const candidate = Math.abs(value);
      if (candidate > magnitude) {
        magnitude = candidate;
        extreme = value;
      }
    }

    const feature: TrackFeature = {
      start: binStart,
      end: Math.max(binStart + 1, binEnd),
      score: magnitude >= 0 && Number.isFinite(extreme) ? extreme : 0,
    };
    if (seriesIndex !== undefined) {
      feature.seriesIndex = seriesIndex;
    }
    features.push(feature);
  }

  return features;
}

