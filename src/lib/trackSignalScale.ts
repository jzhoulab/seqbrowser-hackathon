import { resolveComputationalTrackSubtracks } from './computationalPlotGroups';
import type { SignalDomain } from './signalScale';
import type { TrackFeature, TrackSpec, ViewportState } from '../types';

export type EffectiveSignalScale = {
  mode: 'auto' | 'linked' | 'fixed';
  domain: SignalDomain;
};

/** A composite is signed when any represented model output is signed. */
export function trackUsesSignedSignalScale(track: TrackSpec): boolean {
  if (track.source.type === 'group') {
    return track.source.members.some(trackUsesSignedSignalScale);
  }
  return track.source.type === 'computational' &&
    resolveComputationalTrackSubtracks(track.source).some(
      (subtrack) => subtrack.scaleMode === 'signed',
    );
}

/** Every represented output declares itself positive, so a stray negative is noise, not a sign. */
function declaredPositive(track: TrackSpec): boolean {
  if (track.source.type === 'group') {
    return track.source.members.length > 0 && track.source.members.every(declaredPositive);
  }
  if (track.source.type !== 'computational') {
    return false;
  }
  const subtracks = resolveComputationalTrackSubtracks(track.source);
  return subtracks.length > 0 && subtracks.every((subtrack) => subtrack.scaleMode === 'positive');
}

/**
 * Derive the scientifically meaningful visible-range domain before a display
 * policy is applied. Positive signals stay anchored at zero; signed model
 * outputs use a symmetric domain so zero remains visually centered.
 */
export function computeVisibleSignalDomain(
  track: TrackSpec,
  viewport: ViewportState,
  features: readonly TrackFeature[] | undefined,
): SignalDomain | null {
  if (track.kind !== 'signal' || !features || features.length === 0 || viewport.widthPx <= 0) {
    return null;
  }

  const explicitlyPositiveModel = declaredPositive(track);
  let signed = trackUsesSignedSignalScale(track);
  let maxValue = 0;
  for (const feature of features) {
    if (
      feature.end < viewport.range.start ||
      feature.start > viewport.range.end ||
      !Number.isFinite(feature.score)
    ) {
      continue;
    }
    if (!explicitlyPositiveModel && feature.score < 0) {
      signed = true;
    }
    maxValue = Math.max(maxValue, signed ? Math.abs(feature.score) : feature.score);
  }

  // A negative value may appear after earlier positive values were inspected;
  // recompute the absolute maximum once the display is known to be signed.
  if (signed) {
    maxValue = 0;
    for (const feature of features) {
      if (
        feature.end < viewport.range.start ||
        feature.start > viewport.range.end ||
        !Number.isFinite(feature.score)
      ) {
        continue;
      }
      maxValue = Math.max(maxValue, Math.abs(feature.score));
    }
  }

  if (maxValue <= 0) {
    return null;
  }
  return signed
    ? { min: -maxValue, max: maxValue }
    : { min: 0, max: maxValue };
}

/** Linked comparison groups are isolated to one exact active viewport. */
export function buildLinkedSignalViewportKey(
  viewport: ViewportState,
  resolutionBp: number,
): string {
  return JSON.stringify([
    viewport.assemblyId ?? '',
    viewport.chr,
    viewport.range.start,
    viewport.range.end,
    resolutionBp,
  ]);
}

/** Apply a track's display policy without mutating its raw local domain. */
export function resolveEffectiveSignalScale(
  track: TrackSpec,
  localDomain: SignalDomain | null,
  linkedDomain: SignalDomain | null,
): EffectiveSignalScale | null {
  const scale = track.yScale ?? { mode: 'auto' as const };
  if (scale.mode === 'fixed') {
    if (Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min) {
      // Fixed bounds are already validated by the manager and are used exactly.
      return { mode: 'fixed', domain: { min: scale.min, max: scale.max } };
    }
    return null;
  }
  if (scale.mode === 'linked') {
    const domain = linkedDomain ?? localDomain;
    return domain ? { mode: 'linked', domain } : null;
  }
  return localDomain ? { mode: 'auto', domain: localDomain } : null;
}
