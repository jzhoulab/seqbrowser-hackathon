import { normalizeBase } from '../data/sequenceDataSource';
import { clamp } from './genomeMath';
import { applySignalScaleShape, type SignalScaleShape } from './signalScaleShape';
import type { SignalDomain } from './signalScale';
import type { TrackFeature } from '../types';

export type SequenceSignalRenderMode = 'letters' | 'cells' | 'signal';

export const SEQUENCE_SIGNAL_LETTER_MIN_PX_PER_BASE = 6.5;
export const SEQUENCE_SIGNAL_CELL_MIN_PX_PER_BASE = 1.5;

export type ReferenceSequenceWindow = {
  sequence: string;
  start: number;
  end: number;
};

export type SequenceSignalColumn = {
  feature: TrackFeature;
  base: string;
  position: number;
};

export type SignalBarGeometry = {
  baselineY: number;
  valueY: number;
  y: number;
  height: number;
  direction: 'positive' | 'negative' | 'zero';
};

export function isOneBaseFeature(feature: TrackFeature): boolean {
  const start = Math.round(feature.start);
  const end = Math.round(feature.end);
  return (
    Math.abs(feature.start - start) < 1e-6 &&
    Math.abs(feature.end - end) < 1e-6 &&
    end - start === 1
  );
}

export function chooseSequenceSignalRenderMode(
  bpPerPx: number,
  resolutionBp: number,
  seriesCount: number,
  features: readonly TrackFeature[],
): SequenceSignalRenderMode {
  if (
    seriesCount !== 1 ||
    Math.max(1, Math.floor(resolutionBp)) !== 1 ||
    features.length === 0 ||
    features.some((feature) => !isOneBaseFeature(feature))
  ) {
    return 'signal';
  }

  const pixelsPerBase = 1 / Math.max(Number.EPSILON, bpPerPx);
  if (pixelsPerBase >= SEQUENCE_SIGNAL_LETTER_MIN_PX_PER_BASE) {
    return 'letters';
  }
  if (pixelsPerBase >= SEQUENCE_SIGNAL_CELL_MIN_PX_PER_BASE) {
    return 'cells';
  }
  return 'signal';
}

export function buildSequenceSignalColumns(
  features: readonly TrackFeature[],
  reference: ReferenceSequenceWindow,
  visibleStart: number,
  visibleEnd: number,
): SequenceSignalColumn[] {
  if (
    reference.sequence.length === 0 ||
    reference.end <= reference.start ||
    reference.sequence.length < reference.end - reference.start
  ) {
    return [];
  }

  const columns: SequenceSignalColumn[] = [];
  for (const feature of features) {
    if (
      !isOneBaseFeature(feature) ||
      feature.end <= visibleStart ||
      feature.start >= visibleEnd ||
      !Number.isFinite(feature.score)
    ) {
      continue;
    }

    const position = Math.round(feature.start);
    const offset = position - reference.start;
    if (offset < 0 || offset >= reference.sequence.length) {
      continue;
    }
    columns.push({
      feature,
      base: normalizeBase(reference.sequence[offset] ?? 'N'),
      position,
    });
  }
  return columns;
}

export function computeSignalBarGeometry(
  score: number,
  domain: SignalDomain,
  plotTop: number,
  plotBottom: number,
  scaleShape: SignalScaleShape = 'linear',
): SignalBarGeometry | null {
  const span = domain.max - domain.min;
  if (!Number.isFinite(score) || !Number.isFinite(span) || span <= 0 || plotBottom <= plotTop) {
    return null;
  }

  const yForScore = (value: number) => {
    const normalized = clamp((value - domain.min) / span, 0, 1);
    return plotBottom - normalized * (plotBottom - plotTop);
  };
  const baselineY = yForScore(0);
  const valueY = yForScore(applySignalScaleShape(score, domain, scaleShape));
  const height = Math.abs(valueY - baselineY);
  return {
    baselineY,
    valueY,
    y: Math.min(valueY, baselineY),
    height,
    direction: score > 0 ? 'positive' : score < 0 ? 'negative' : 'zero',
  };
}

export type SequenceGlyphFit = {
  /** Column width the glyph is clipped to, inset by a hairline from its neighbour. */
  width: number;
  /** Horizontal scale that makes the glyph span that column. */
  scaleX: number;
};

/**
 * Fit a base glyph to the pixel column its base occupies.
 *
 * A sequence logo stretches each letter across its column; the glyph's natural
 * advance width is irrelevant. Capping the scale at 1 left a ~7px monospace glyph
 * sitting inside a wider base slot, and the leftover read as a gap between letters --
 * at 10px per base that was 2.8px of empty column, over a quarter of it.
 */
export function computeSequenceGlyphFit(rawWidthPx: number, measuredWidthPx: number): SequenceGlyphFit {
  const width = Math.max(0.75, rawWidthPx - Math.min(0.35, rawWidthPx * 0.06));
  const measured = Math.max(1, measuredWidthPx);
  return { width, scaleX: Math.max(0.1, width / measured) };
}
