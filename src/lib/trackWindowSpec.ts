import { clampRangeToChromosome } from './genomeMath';
import { effectiveComputationalMaxWindowBp } from './computationalLimits';
import { SEQUENCE_SIGNAL_CELL_MIN_PX_PER_BASE } from './signalSequenceDisplay';
import type { DataWindowSpec, TrackSpec, ViewportState } from '../types';

const COMPUTATIONAL_MIN_WINDOW_BP = 512;
const COMPUTATIONAL_FAST_VIEW_MULTIPLIER = 2.5;
const COMPUTATIONAL_MIN_FLANK_MARGIN_BP = 64;
function requiresBaseResolution(track: TrackSpec, viewport: ViewportState): boolean {
  if (track.kind !== 'signal' || track.signalDisplay !== 'sequence') {
    return false;
  }
  if (
    track.source.type === 'computational' &&
    (track.source.seriesSubtrackIds?.length ?? 1) > 1
  ) {
    return false;
  }
  return 1 / Math.max(Number.EPSILON, viewport.bpPerPx) >= SEQUENCE_SIGNAL_CELL_MIN_PX_PER_BASE;
}

function toFlankBp(track: TrackSpec): number {
  if (track.source.type !== 'computational') {
    return 0;
  }
  const raw = track.source.pack.inference?.flankBp;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}

function toStableMarginBp(track: TrackSpec): number {
  if (track.source.type !== 'computational') {
    return 0;
  }

  const seriesIds = track.source.seriesSubtrackIds;
  const subtracks = seriesIds && seriesIds.length > 0
    ? [
        track.source.subtrack,
        ...track.source.pack.subtracks.filter((subtrack) => seriesIds.includes(subtrack.id)),
      ]
    : [track.source.subtrack];

  return subtracks.reduce((largestMargin, subtrack) => {
    const raw = subtrack.stableMarginBp;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return largestMargin;
    }
    return Math.max(largestMargin, Math.max(0, Math.floor(raw)));
  }, 0);
}

function deriveEffectiveStableMarginBp(
  stableMarginBp: number,
  requestSpanBp: number,
  viewportSpanBp: number,
): number {
  if (stableMarginBp <= 0) {
    return 0;
  }

  // Leave one base beyond the protected viewport for integer request starts.
  // Without that reserve, a fractional viewport boundary can make two exact
  // margins mathematically wide enough but impossible to satisfy by an integer
  // genomic interval.
  const availablePerSide = Math.max(0, requestSpanBp - viewportSpanBp - 1) / 2;
  return Math.min(stableMarginBp, availablePerSide);
}

function deriveStrideBp(
  spanBp: number,
  viewportSpanBp: number,
  stableMarginBp = 0,
): number {
  // A snapped request must cover the full viewport. Therefore adjacent request
  // starts cannot be farther apart than the overscan outside the protected
  // viewport. Keep one extra base of overlap for fractional viewport edges:
  // floor/ceil rounding can otherwise make the feasible integer-start interval
  // one base narrower.
  const protectedViewportSpanBp = viewportSpanBp + stableMarginBp * 2;
  const coverageStride = Math.max(1, Math.floor(spanBp - protectedViewportSpanBp) - 1);
  const maxStride = Math.max(1, spanBp - 1);
  return Math.max(1, Math.min(coverageStride, maxStride));
}

function deriveFastWindowBp(
  viewportSpanBp: number,
  flankBp: number,
  stableMarginBp: number,
): number {
  const bufferedViewportBp = Math.max(
    COMPUTATIONAL_MIN_WINDOW_BP,
    Math.floor(viewportSpanBp * COMPUTATIONAL_FAST_VIEW_MULTIPLIER),
    flankBp * 2 + COMPUTATIONAL_MIN_FLANK_MARGIN_BP,
  );
  // Stable margins are additional protected context around the existing fast
  // viewport buffer, rather than a replacement for its pan overscan.
  return bufferedViewportBp + stableMarginBp * 2;
}

function deriveCoverageSnappedStart(
  maxStart: number,
  viewportStart: number,
  viewportEnd: number,
  requestSpanBp: number,
  strideBp: number,
): number {
  const minCoverStart = Math.max(0, Math.min(maxStart, Math.ceil(viewportEnd - requestSpanBp)));
  const maxCoverStart = Math.max(0, Math.min(maxStart, Math.floor(viewportStart)));
  if (maxCoverStart <= minCoverStart) {
    return minCoverStart;
  }

  let snappedStart = Math.floor(maxCoverStart / strideBp) * strideBp;
  if (snappedStart < minCoverStart) {
    const snappedUp = Math.ceil(minCoverStart / strideBp) * strideBp;
    if (snappedUp <= maxCoverStart) {
      snappedStart = snappedUp;
    } else {
      snappedStart = minCoverStart;
    }
  }

  if (snappedStart > maxCoverStart) {
    snappedStart = maxCoverStart;
  }

  return Math.max(minCoverStart, Math.min(maxCoverStart, snappedStart));
}

const MUTAGENESIS_FOCUS_SNAP_BP = 16;

/**
 * A mutagenesis row is paid per base on screen, not per window: the window is
 * still fetched and scored whole as context, and only the bases in view are
 * mutated. So the visible range, snapped so small pans reuse a window, rides
 * along in the spec and its key. Past the row's declared width there is no
 * focus, and the worker returns the row empty.
 */
function withMutagenesisFocus(
  track: TrackSpec,
  clampedViewport: { start: number; end: number; span: number },
  spec: DataWindowSpec,
): DataWindowSpec {
  if (track.source.type !== 'computational') {
    return spec;
  }
  const mutagenesis = track.source.subtrack.mutagenesis;
  if (!mutagenesis || (track.source.seriesSubtrackIds?.length ?? 1) > 1) {
    return spec;
  }
  if (clampedViewport.span > mutagenesis.maxSpanBp) {
    return spec;
  }
  const start = Math.max(
    spec.requestStart,
    Math.floor(clampedViewport.start / MUTAGENESIS_FOCUS_SNAP_BP) * MUTAGENESIS_FOCUS_SNAP_BP,
  );
  const end = Math.min(
    spec.requestEnd,
    Math.ceil(clampedViewport.end / MUTAGENESIS_FOCUS_SNAP_BP) * MUTAGENESIS_FOCUS_SNAP_BP,
  );
  if (end <= start) {
    return spec;
  }
  return { ...spec, key: `${spec.key}:ism${start}-${end}`, focus: { start, end } };
}

export function deriveTrackWindowSpec(
  track: TrackSpec,
  viewport: ViewportState,
  baseSpec: DataWindowSpec,
): DataWindowSpec {
  if (track.source.type === 'group') {
    // A combined row asks for one window and hands it to every member. A model
    // output needs its snapped, flanked window; a bigWig answers any range. So
    // the first model member decides, and a group of data tracks uses the base.
    const model = track.source.members.find((member) => member.source.type === 'computational');
    return model ? deriveTrackWindowSpec(model, viewport, baseSpec) : baseSpec;
  }
  if (track.source.type !== 'computational') {
    return requiresBaseResolution(track, viewport)
      ? { ...baseSpec, key: `${baseSpec.key}:dna-r1`, resolutionBp: 1 }
      : baseSpec;
  }

  const clampedViewport = clampRangeToChromosome(viewport.range, viewport.chrLength);
  const configuredMaxWindowBp = effectiveComputationalMaxWindowBp(track.source.pack);
  const flankBp = toFlankBp(track);
  const stableMarginBp = toStableMarginBp(track);
  const fastWindowBp = deriveFastWindowBp(clampedViewport.span, flankBp, stableMarginBp);
  const targetWindowBp = Math.max(1, Math.min(configuredMaxWindowBp, fastWindowBp));
  if (viewport.chrLength <= targetWindowBp) {
    return withMutagenesisFocus(track, clampedViewport, {
      key: `${viewport.chr}:0:${viewport.chrLength}:comp`,
      requestStart: 0,
      requestEnd: viewport.chrLength,
      resolutionBp: requiresBaseResolution(track, viewport) ? 1 : baseSpec.resolutionBp,
    });
  }

  const effectiveStableMarginBp = deriveEffectiveStableMarginBp(
    stableMarginBp,
    targetWindowBp,
    clampedViewport.span,
  );
  const strideBp = deriveStrideBp(
    targetWindowBp,
    clampedViewport.span,
    effectiveStableMarginBp,
  );
  const maxStart = Math.max(0, viewport.chrLength - targetWindowBp);
  const protectedViewportStart = clampedViewport.start - Math.min(
    effectiveStableMarginBp,
    clampedViewport.start,
  );
  const protectedViewportEnd = clampedViewport.end + Math.min(
    effectiveStableMarginBp,
    viewport.chrLength - clampedViewport.end,
  );
  const requestStart = deriveCoverageSnappedStart(
    maxStart,
    protectedViewportStart,
    protectedViewportEnd,
    targetWindowBp,
    strideBp,
  );
  let requestEnd = requestStart + targetWindowBp;

  if (requestEnd > viewport.chrLength) {
    requestEnd = viewport.chrLength;
  }

  return withMutagenesisFocus(track, clampedViewport, {
    key: `${viewport.chr}:${requestStart}:${requestEnd}:comp`,
    requestStart,
    requestEnd,
    resolutionBp: requiresBaseResolution(track, viewport) ? 1 : baseSpec.resolutionBp,
  });
}

export function deriveComputationalNeighborSpecs(
  track: TrackSpec,
  viewport: ViewportState,
  spec: DataWindowSpec,
): DataWindowSpec[] {
  if (track.source.type !== 'computational') {
    return [];
  }
  // A focused window is paid for the bases on screen; a neighbouring window
  // would carry the same focus, which lies outside it. Nothing to prefetch.
  if (spec.focus) {
    return [];
  }

  const spanBp = Math.max(1, spec.requestEnd - spec.requestStart);
  if (viewport.chrLength <= spanBp) {
    return [];
  }

  const clampedViewport = clampRangeToChromosome(viewport.range, viewport.chrLength);
  const stableMarginBp = deriveEffectiveStableMarginBp(
    toStableMarginBp(track),
    spanBp,
    clampedViewport.span,
  );
  const strideBp = deriveStrideBp(spanBp, clampedViewport.span, stableMarginBp);
  const maxNeighborStart = Math.max(0, viewport.chrLength - spanBp);
  const starts = [
    Math.max(0, spec.requestStart - strideBp),
    Math.min(maxNeighborStart, spec.requestStart + strideBp),
  ];

  const uniqueStarts = Array.from(new Set(starts)).filter((start) => start !== spec.requestStart);
  return uniqueStarts.map((start, index) => ({
    key: `${viewport.chr}:${start}:${start + spanBp}:comp:n${index}`,
    requestStart: start,
    requestEnd: start + spanBp,
    resolutionBp: spec.resolutionBp,
  }));
}
