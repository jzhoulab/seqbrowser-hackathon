import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { fetchMutantPredictions } from '../data/computationalDataSource';
import { mutantOverlayIndex } from '../lib/mutagenesis';
import {
  clearMutantOverlay,
  getMutantOverlay,
  setMutantOverlay,
  subscribeMutantOverlay,
  type MutantOverlay,
} from '../lib/mutantOverlayStore';
import type { TrackGrouping } from '../features/tracks/listRows';
import {
  clamp,
  clampRangeToChromosome,
  formatPosition,
  formatRange,
} from '../lib/genomeMath';
import { trackRedrawScheduler } from '../lib/trackRedrawScheduler';
import { deriveComputationalEligibility } from '../lib/computationalEligibility';
import {
  getViewportPalette,
  isViewportDark,
  subscribeViewportTheme,
} from '../lib/viewportTheme';
import type { ViewportPalette } from '../lib/viewportTheme';
import { useTrackWindowData } from '../hooks/useTrackWindowData';
import { useReferenceSequenceWindow } from '../hooks/useReferenceSequenceWindow';
import { useSignalDistribution } from '../hooks/useSignalDistribution';
import {
  buildWindowMeanLadder,
  formatPercentile,
  percentileOfValue,
  regionMean,
} from '../lib/signalDistribution';
import {
  resolveComputationalSeriesLineStyle,
  resolveComputationalTrackSubtracks,
} from '../lib/computationalPlotGroups';
import { plotGroupingAction } from '../lib/userPlotGroups';
import { stackedSwatch } from '../lib/seriesSwatch';
import { linkedSignalDomainRegistry } from '../lib/signalScale';
import {
  buildSequenceColumnLayout,
  layoutIsLinear,
  rowHasPerBaseColumns,
  type SequenceColumnLayout,
} from '../lib/sequenceColumnLayout';
import {
  applySignalScaleShape,
  formatProbabilityNines,
  nextSignalScaleShapeFor,
  resolveSignalScaleShape,
  signalScaleShapeLabel,
  signalScaleShapeTitle,
  type SignalScaleShape,
} from '../lib/signalScaleShape';
import type { SignalDomain } from '../lib/signalScale';
import {
  buildLinkedSignalViewportKey,
  computeVisibleSignalDomain,
  resolveEffectiveSignalScale,
} from '../lib/trackSignalScale';
import {
  buildSequenceSignalColumns,
  chooseSequenceSignalRenderMode,
  computeSignalBarGeometry,
  type ReferenceSequenceWindow,
  type SequenceSignalColumn,
  type SequenceSignalRenderMode,
  computeSequenceGlyphFit,
} from '../lib/signalSequenceDisplay';
import {
  formatSpliceMotif,
  readSpliceMotif,
  spliceCallSuitsGeneStrand,
  spliceSiteKindFromName,
  type SpliceSiteKind,
} from '../lib/spliceMotif';
import {
  EMPTY_GENE_STRAND_COVERAGE,
  geneStrandCoverageKey,
  geneStrandRegistry,
  geneStrandSpansFrom,
  type GeneStrandCoverage,
} from '../lib/geneStrandCoverage';
import { signalRenderStyle } from '../lib/signalRenderStyle';
import { SignalContextStrip } from './SignalContextStrip';
import { buildDisplayAxis, complementBase, drawEditBands } from '../lib/displayAxis';
import {
  ANNOTATION_LABEL_FONT_PX,
  annotationHeightForLanes,
  annotationLaneGeometry,
  annotationLanesFitLabels,
  annotationLanesThatFit,
  clampLaneOffset,
  clampTrackHeightPx,
  layoutAnnotationGeneLabels,
  maxTrackHeightPx,
} from '../lib/annotationLayout';
import type {
  ComputationalSubtrackSpec,
  DataWindowSpec,
  SequenceEdit,
  SignalDisplayMode,
  TrackFeature,
  TrackSpec,
  ViewportState,
} from '../types';

type TrackRowCanvasProps = {
  track: TrackSpec;
  selected?: boolean;
  onSelect?: (track: TrackSpec) => void;
  /**
   * The model group and collection this row sits under, with their colours:
   * the row wears them as rails so it reads as part of its group in the list.
   */
  grouping?: TrackGrouping;
  viewport: ViewportState;
  windowSpec: DataWindowSpec;
  genome: string;
  onSignalDisplayChange?: (track: TrackSpec, display: SignalDisplayMode) => void;
  onSignalScaleShapeChange?: (track: TrackSpec, shape: SignalScaleShape) => void;
  /** Split a combined plot into rows, recombine it, or dissolve a user group. */
  onPlotGroupingChange?: (track: TrackSpec, action: 'split' | 'combine' | 'ungroup') => void;
  /** On a row mirrored onto the edited sequence: stop mirroring this output. */
  onHideOnEdited?: (track: TrackSpec) => void;
  /**
   * The reader set this row's height: dragged its lower edge, or asked it to
   * grow to fit. Offered on annotation rows, the one kind whose height decides
   * what is on screen rather than how large it is drawn.
   */
  onHeightChange?: (track: TrackSpec, heightPx: number) => void;
  /**
   * Insertions from every sequence row on screen. A prediction has to be laid
   * out in the same columns as the sequence it belongs to, so the bars stay
   * under their bases whichever row inserted them.
   */
  columnEdits?: readonly SequenceEdit[];
  /**
   * Minus strand. The whole row is mirrored so it reads 5'->3' of that strand, in
   * step with the sequence row above it and the ruler. Applied once as a canvas
   * transform at the draw entry point rather than in each renderer.
   */
  reversed?: boolean;
};

type PositionedAnnotationFeature = {
  feature: TrackFeature;
  x: number;
  w: number;
  lane: number;
};

type AnnotationDrawMode = 'full' | 'squish' | 'density';
type TrackScaleInfo = {
  topLabel: string;
  bottomLabel: string;
  kind: 'signal' | 'signed' | 'density';
  mode: 'auto' | 'linked' | 'fixed';
  domain: SignalDomain;
  /** Raw auto-scale maximum, for ranking against the genome-wide distribution. */
  maxValue: number;
};
type SignalSeriesMetadata = Pick<ComputationalSubtrackSpec, 'id' | 'name' | 'color'> & {
  lineStyle: 'solid' | 'dashed';
};

/**
 * The hovered ISM base's mean-mutant prediction, resolved for one row: which
 * channel of it each of the row's series shows (null for a series that is not
 * this model's output), and how to find a column in it.
 */
type MutantOverlayDraw = {
  overlay: MutantOverlay;
  channelBySeries: readonly (number | null)[];
  indexOf: (genomic: number, insertionOffset?: number) => number;
};

/** "mean mutant 0.99→0.21 at +2": the largest change the three mutants make on average, and where. */
function describeMutantEffect(effect: NonNullable<TrackFeature['mutantEffect']>): string {
  const where = effect.offset === 0 ? 'here' : `${effect.offset > 0 ? '+' : '−'}${Math.abs(effect.offset)}`;
  return `mean mutant ${effect.reference.toFixed(2)}→${effect.mutant.toFixed(2)} at ${where}`;
}

/** How far the mean mutant has to move a value before an arrow marks it. */
const MUTANT_OVERLAY_MIN_CHANGE = 0.02;

/**
 * The mean mutant's value for one of the row's features, or null where the
 * overlay has no column for it. Applied as a change to the row's own value, so
 * a position the mutation leaves alone draws exactly as it did.
 */
function overlayMutantValue(draw: MutantOverlayDraw, channel: number, feature: TrackFeature): number | null {
  const index = feature.insertionBefore !== undefined
    ? draw.indexOf(feature.insertionBefore, feature.insertionOffset ?? 0)
    : feature.end - feature.start <= 1
      ? draw.indexOf(Math.round(feature.start))
      : -1;
  if (index < 0) {
    return null;
  }
  const data = draw.overlay.data;
  const at = channel * data.length + index;
  return feature.score + ((data.mean[at] ?? 0) - (data.reference[at] ?? 0));
}

/** A vertical arrow from the original value to the mutant's, its head at the mutant end. */
function drawChangeArrow(
  context: CanvasRenderingContext2D,
  x: number,
  fromY: number,
  toY: number,
  halfWidth: number,
): void {
  const span = Math.abs(toY - fromY);
  if (span < 3) {
    return;
  }
  const direction = toY < fromY ? -1 : 1;
  const head = Math.min(span, halfWidth * 1.6);
  context.beginPath();
  context.moveTo(x, fromY);
  context.lineTo(x, toY - direction * head);
  context.stroke();
  context.beginPath();
  context.moveTo(x, toY);
  context.lineTo(x - halfWidth, toY - direction * head);
  context.lineTo(x + halfWidth, toY - direction * head);
  context.closePath();
  context.fill();
}

/** Which base was mutated, and what the row is showing while it is. */
function drawMutantMarker(
  context: CanvasRenderingContext2D,
  draw: MutantOverlayDraw,
  startBp: number,
  bpPerPx: number,
  widthPx: number,
  columnLayout: SequenceColumnLayout | null,
  plotTop: number,
  plotBottom: number,
  palette: ViewportPalette,
): void {
  const data = draw.overlay.data;
  let x: number | null = (data.position - startBp) / bpPerPx;
  let width = Math.max(1, 1 / bpPerPx);
  if (columnLayout) {
    const index = columnLayout.indexOfBase(data.position);
    width = Math.max(1, columnLayout.columnWidth * widthPx);
    x = index < 0 ? null : index * width;
  }
  context.save();
  if (x !== null) {
    // A faint guide through the mutated base, and a tick under it.
    context.globalAlpha = 0.55;
    context.strokeStyle = palette.axis;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(x + width / 2, plotTop);
    context.lineTo(x + width / 2, plotBottom);
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
    context.fillStyle = palette.ink;
    context.fillRect(x, plotBottom + 1, Math.max(2, width), 2);
  }
  context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.fillStyle = palette.ink;
  upright(
    context,
    `bars: mean of ${data.refBase}→${data.alts.split('').join('/')} at ${formatPosition(data.position)} · outline: original`,
    8,
    plotTop + 11,
  );
  context.restore();
}

const ANNOTATION_SQUISH_BP_PER_PX = 2_600;
const ANNOTATION_DENSITY_BP_PER_PX = 9_500;
const ANNOTATION_MAX_VISIBLE_FULL = 1_200;
const ANNOTATION_MAX_VISIBLE_SQUISH = 4_200;
const ANNOTATION_MAX_LANES_FULL = 8;
const ANNOTATION_MAX_LANES_SQUISH = 3;
const ANNOTATION_MAX_LABELS = 120;

function chooseAnnotationMode(
  visibleFeatureCount: number,
  bpPerPx: number,
  hasDensitySummary: boolean,
): AnnotationDrawMode {
  if (
    hasDensitySummary ||
    bpPerPx >= ANNOTATION_DENSITY_BP_PER_PX ||
    visibleFeatureCount > ANNOTATION_MAX_VISIBLE_SQUISH
  ) {
    return 'density';
  }

  if (
    bpPerPx >= ANNOTATION_SQUISH_BP_PER_PX ||
    visibleFeatureCount > ANNOTATION_MAX_VISIBLE_FULL
  ) {
    return 'squish';
  }

  return 'full';
}

function packOverlappingFeatures(
  features: PositionedAnnotationFeature[],
  startLane: number,
  collisionGapPx: number,
): number {
  if (features.length === 0) {
    return 0;
  }

  features.sort((left, right) => left.x - right.x || right.w - left.w);

  const laneEnds: number[] = [];
  for (const feature of features) {
    const xEnd = feature.x + feature.w;
    let laneIndex = 0;
    while (
      laneIndex < laneEnds.length &&
      feature.x < laneEnds[laneIndex] + collisionGapPx
    ) {
      laneIndex += 1;
    }

    if (laneIndex === laneEnds.length) {
      laneEnds.push(xEnd);
    } else {
      laneEnds[laneIndex] = Math.max(laneEnds[laneIndex], xEnd);
    }

    feature.lane = startLane + laneIndex;
  }

  return laneEnds.length;
}

function formatScaleValue(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return '0';
  }

  if (value < 0) {
    return `−${formatScaleValue(Math.abs(value))}`;
  }

  if (value >= 1000) {
    return Math.round(value).toLocaleString('en-US');
  }
  if (value >= 100) {
    return value.toFixed(0);
  }
  if (value >= 10) {
    return value.toFixed(1).replace(/\.0$/, '');
  }
  if (value >= 1) {
    return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (value >= 0.1) {
    return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  return value.toExponential(2);
}

function computeAnnotationScaleInfo(
  viewport: ViewportState,
  features: TrackFeature[] | undefined,
): TrackScaleInfo | null {
  if (!features || features.length === 0 || viewport.widthPx <= 0) {
    return null;
  }

  const boundedRange = clampRangeToChromosome(viewport.range, viewport.chrLength);
  const startBp = boundedRange.start;
  const endBp = boundedRange.end;
  const visibleFeatures: TrackFeature[] = [];

  for (const feature of features) {
    if (feature.end < startBp || feature.start > endBp) {
      continue;
    }
    visibleFeatures.push(feature);
  }

  if (visibleFeatures.length === 0) {
    return null;
  }

  const hasDensitySummary = visibleFeatures.some((item) => item.renderMode === 'density');
  const mode = chooseAnnotationMode(visibleFeatures.length, viewport.bpPerPx, hasDensitySummary);
  if (mode !== 'density') {
    return null;
  }

  const binCount = Math.max(1, Math.floor(viewport.widthPx));
  const diff = new Float32Array(binCount + 1);
  for (const feature of visibleFeatures) {
    const x = (feature.start - startBp) / viewport.bpPerPx;
    const w = Math.max(1.5, (feature.end - feature.start) / viewport.bpPerPx);
    // Round BOTH edges so adjacent summary bins tile the pixel grid without
    // overlap. floor(start) with ceil(end) claimed the boundary pixel for both
    // neighbours, doubling the density there -- a one-pixel spike at every bin
    // boundary, evenly spaced across the whole track.
    const startBin = clamp(Math.round(x), 0, binCount - 1);
    const endBinExclusive = clamp(Math.round(x + w), 1, binCount);
    const boundedEnd = endBinExclusive <= startBin ? Math.min(binCount, startBin + 1) : endBinExclusive;
    const weight = feature.renderMode === 'density' ? Math.max(0, feature.score) : 1;
    diff[startBin] += weight;
    diff[boundedEnd] -= weight;
  }

  let value = 0;
  let maxDensity = 0;
  for (let index = 0; index < binCount; index += 1) {
    value += diff[index];
    if (value > maxDensity) {
      maxDensity = value;
    }
  }

  if (maxDensity <= 0) {
    return null;
  }

  return {
    topLabel: formatScaleValue(maxDensity),
    bottomLabel: '0',
    kind: 'density',
    mode: 'auto',
    domain: { min: 0, max: maxDensity },
    maxValue: maxDensity,
  };
}

/**
 * Draw text that reads left-to-right even when the context is mirrored for the
 * minus strand. The x passed is the text's LEFT edge in the current (possibly
 * mirrored) coordinate space, so a caller can keep positioning text relative to
 * the geometry it labels; the helper undoes the mirror around that point.
 */
function upright(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth?: number,
): void {
  const mirrored = context.getTransform().a < 0;
  if (!mirrored) {
    if (maxWidth === undefined) context.fillText(text, x, y);
    else context.fillText(text, x, y, maxWidth);
    return;
  }
  const width = Math.min(maxWidth ?? Infinity, context.measureText(text).width);
  context.save();
  // Flip back around the text's right edge so it occupies [x, x+width] on screen.
  context.translate(x + width, 0);
  context.scale(-1, 1);
  if (maxWidth === undefined) context.fillText(text, 0, y);
  else context.fillText(text, 0, y, maxWidth);
  context.restore();
}

/**
 * Row chrome pinned to the top-right corner of the SCREEN: "squish · +48 hidden",
 * "1 antisense hidden", the render-mode tag. These describe the row, not a
 * position on it, so they stay put when the strand flips and the geometry
 * mirrors underneath them.
 */
function cornerNote(context: CanvasRenderingContext2D, text: string, widthPx: number): void {
  const mirrored = context.getTransform().a < 0;
  const textWidth = context.measureText(text).width;
  const screenX = Math.max(4, widthPx - textWidth - 6);
  // In mirrored space, screen-x maps to (widthPx - x); upright() then un-mirrors the glyphs.
  upright(context, text, mirrored ? widthPx - screenX - textWidth : screenX, 3);
}

function drawHoverGuide(
  context: CanvasRenderingContext2D,
  hoverX: number,
  topY: number,
  bottomY: number,
  palette: ViewportPalette,
): void {
  context.strokeStyle = palette.axis;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(Math.round(hoverX) + 0.5, topY);
  context.lineTo(Math.round(hoverX) + 0.5, bottomY);
  context.stroke();
}

function drawHoverLabel(
  context: CanvasRenderingContext2D,
  label: string,
  hoverX: number,
  widthPx: number,
  y: number,
  palette: ViewportPalette,
): void {
  context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textBaseline = 'top';
  const labelWidth = context.measureText(label).width;
  const boxWidth = labelWidth + 8;
  const boxX = clamp(hoverX + 8, 2, Math.max(2, widthPx - boxWidth - 2));

  context.fillStyle = palette.labelBoxBg;
  context.fillRect(boxX, y, boxWidth, 14);
  context.strokeStyle = palette.labelBoxBorder;
  context.strokeRect(boxX + 0.5, y + 0.5, boxWidth - 1, 13);
  context.fillStyle = palette.ink;
  upright(context, label, boxX + 4, y + 2);
}

function drawTrackHint(
  context: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  message: string,
  palette: ViewportPalette,
): void {
  context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textBaseline = 'middle';
  const messageWidth = context.measureText(message).width;
  const boxWidth = Math.min(widthPx - 20, messageWidth + 14);
  const boxX = Math.max(10, Math.floor((widthPx - boxWidth) * 0.5));
  const boxY = Math.max(8, Math.floor((heightPx - 18) * 0.5));

  context.fillStyle = palette.labelBoxBg;
  context.fillRect(boxX, boxY, boxWidth, 18);
  context.strokeStyle = palette.labelBoxBorder;
  context.strokeRect(boxX + 0.5, boxY + 0.5, boxWidth - 1, 17);
  context.fillStyle = palette.inkSoft;
  upright(context, message, boxX + 7, boxY + 9, boxWidth - 12);
}


function drawSignal(
  context: CanvasRenderingContext2D,
  features: TrackFeature[],
  startBp: number,
  bpPerPx: number,
  widthPx: number,
  heightPx: number,
  hoverX: number | null,
  palette: ViewportPalette,
  domain: SignalDomain,
  series: readonly SignalSeriesMetadata[],
  scaleShape: SignalScaleShape,
  columnLayout: SequenceColumnLayout | null,
  reference: ReferenceSequenceWindow | null,
  geneStrands: GeneStrandCoverage,
  renderStyle: 'bars' | 'line',
  mutantOverlay: MutantOverlayDraw | null = null,
): void {
  // Padding scales with the row: a fixed 10px inset ate most of a short track,
  // leaving a few pixels of plot between the label and the baseline.
  const plotPadding = clamp(heightPx * 0.12, 2, 10);
  const plotTop = plotPadding;
  const plotBottom = heightPx - plotPadding;
  const viewEndBp = startBp + widthPx * bpPerPx;
  const visibleFeatures: TrackFeature[] = [];

  for (const feature of features) {
    if (feature.end < startBp || feature.start > viewEndBp) {
      continue;
    }
    if (!Number.isFinite(feature.score)) {
      continue;
    }
    // Without a column layout there is nowhere to put an inserted base, and
    // drawing it on its neighbour's coordinate would be a lie.
    if (feature.insertionBefore !== undefined && !columnLayout) {
      continue;
    }
    visibleFeatures.push(feature);
  }

  if (visibleFeatures.length === 0) {
    return;
  }


  const domainSpan = domain.max - domain.min;
  if (!Number.isFinite(domainSpan) || domainSpan <= 0) {
    return;
  }
  const yForScore = (score: number) => {
    const shaped = applySignalScaleShape(score, domain, scaleShape);
    const normalized = clamp((shaped - domain.min) / domainSpan, 0, 1);
    return plotBottom - normalized * (plotBottom - plotTop);
  };
  const baseline = yForScore(0);

  const seriesCountForKinds = Math.max(1, series.length);
  const seriesIndexOf = (feature: TrackFeature) =>
    clamp(
      Number.isInteger(feature.seriesIndex) ? (feature.seriesIndex as number) : 0,
      0,
      seriesCountForKinds - 1,
    );
  const seriesKinds: (SpliceSiteKind | null)[] = Array.from(
    { length: seriesCountForKinds },
    (_unused, index) => spliceSiteKindFromName(series[index]?.name, series[index]?.id),
  );
  const motifFor = (feature: TrackFeature) => {
    const kind = seriesKinds[seriesIndexOf(feature)];
    // A binned bar covers a span, and a span has no dinucleotide under it.
    if (!reference || !kind || feature.insertionBefore !== undefined || feature.end - feature.start > 1) {
      return null;
    }
    return readSpliceMotif(reference, Math.round(feature.start), kind);
  };

  // The model scores the strand on screen, and every call it makes is drawn the
  // same way. Where the annotation says the gene runs the other way, the hover
  // label says so: the way to score that gene is to flip the strand. Earlier
  // designs hid, then faded, such calls -- which under a single-strand model
  // emptied, then two-toned, the whole track across a minus-strand gene.
  const shownFeatures = visibleFeatures;
  const geneOnOtherStrand = (feature: TrackFeature): '+' | '-' | null => {
    if (geneStrands.isEmpty) {
      return null;
    }
    const strands = geneStrands.strandsAt(Math.round(feature.start));
    return spliceCallSuitsGeneStrand(motifFor(feature), strands) ? null : strands[0] ?? null;
  };

  // The zero baseline. Signed domains need it as an axis; bar tracks need it as
  // PROOF OF LIFE: a splice model's calls are sparse, and with no baseline a
  // computed stretch with no calls drew literally nothing -- indistinguishable
  // from a model that never ran, with the settled rail showing no status either.
  // A flat line at zero says "computed; nothing here".
  if ((domain.min < 0 && domain.max > 0) || renderStyle === 'bars') {
    context.strokeStyle = palette.axis;
    context.lineWidth = 1;
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(0, Math.round(baseline) + 0.5);
    context.lineTo(widthPx, Math.round(baseline) + 0.5);
    context.stroke();
  }

  // Scores are drawn as vertical bars off the baseline rather than a connected
  // curve: base-resolution model output is a set of per-base values, and joining
  // them implies interpolation between bases that the model never emitted.
  const seriesCount = seriesCountForKinds;
  const featuresBySeries = Array.from({ length: seriesCount }, () => [] as TrackFeature[]);
  for (const feature of shownFeatures) {
    featuresBySeries[seriesIndexOf(feature)].push(feature);
  }
  // The first-declared series draws last, on top: a pack lists its primary
  // output first, and a noisier companion (a branchpoint channel with hundreds
  // of small calls) must not paint over the few tall calls that matter.
  const drawOrder = featuresBySeries.map((_, index) => index).reverse();

  context.save();
  context.beginPath();
  context.rect(0, plotTop, widthPx, plotBottom - plotTop);
  context.clip();

  // Per-base bars say what a base-resolution splice model actually emits, and
  // joining those points would imply interpolation between bases the model never
  // scored. A continuous signal -- Puffin's motif activations, MotifMatch's
  // activity -- reads as a curve, and drew as one before this row learned about
  // bars, so it still does.
  if (renderStyle === 'line') {
    context.lineJoin = 'round';
    context.lineCap = 'round';
    drawOrder.forEach((seriesIndex) => {
      const metadata = series[seriesIndex];
      const seriesFeatures = featuresBySeries[seriesIndex];
      if (!metadata || !seriesFeatures || seriesFeatures.length === 0) {
        return;
      }
      seriesFeatures.sort((left, right) => left.start - right.start || left.end - right.end);
      context.strokeStyle = metadata.color;
      context.lineWidth = 1.35;
      context.setLineDash(metadata.lineStyle === 'dashed' ? [5, 3] : []);
      // A bigWig omits runs where the value is zero (bedGraph encodes absence
      // as nothing), so a gap between two intervals is NOT missing data -- it is
      // a zero run. Drawing nothing there left the curve in disconnected
      // fragments; the honest shape drops to the baseline at the end of one
      // interval, runs along it, and rises at the next. A gap narrower than a
      // pixel is simply joined.
      const strokeCurve = (valueOf: (feature: TrackFeature) => number) => {
        context.beginPath();
        let drewPoint = false;
        let previousEnd = Number.NEGATIVE_INFINITY;
        let previousX = 0;
        let previousY = 0;
        const zeroY = yForScore(0);
        for (const feature of seriesFeatures) {
          const x = ((feature.start + feature.end) * 0.5 - startBp) / bpPerPx;
          const y = yForScore(valueOf(feature));
          const gapBp = feature.start - previousEnd;
          if (!drewPoint) {
            context.moveTo(x, y);
          } else if (gapBp > Math.max(1, bpPerPx)) {
            const gapStartX = (previousEnd - startBp) / bpPerPx;
            const gapEndX = (feature.start - startBp) / bpPerPx;
            context.lineTo(gapStartX, zeroY);
            context.lineTo(gapEndX, zeroY);
            context.lineTo(x, y);
          } else {
            context.lineTo(x, y);
          }
          drewPoint = true;
          previousEnd = feature.end;
          previousX = x;
          previousY = y;
        }
        if (seriesFeatures.length === 1) {
          context.moveTo(previousX - 1, previousY);
          context.lineTo(previousX + 1, previousY);
        }
        context.stroke();
      };
      // Under a hovered ISM base: the mean mutant as the curve, the original
      // under it, translucent.
      const channel = mutantOverlay?.channelBySeries[seriesIndex] ?? null;
      if (mutantOverlay && channel !== null) {
        context.globalAlpha = 0.3;
        strokeCurve((feature) => feature.score);
        context.globalAlpha = 1;
        strokeCurve((feature) => overlayMutantValue(mutantOverlay, channel, feature) ?? feature.score);
      } else {
        context.globalAlpha = mutantOverlay ? 0.4 : 1;
        strokeCurve((feature) => feature.score);
        context.globalAlpha = 1;
      }
    });
    context.setLineDash([]);
  } else {
  drawOrder.forEach((seriesIndex) => {
    const seriesFeatures = featuresBySeries[seriesIndex];
    if (!seriesFeatures || seriesFeatures.length === 0) {
      return;
    }

    const metadata = series[seriesIndex];
    const seriesColor = metadata?.color ?? '#64748B';
    context.fillStyle = seriesColor;
    context.strokeStyle = seriesColor;
    context.lineWidth = 1;
    // A pack marks a series dashed to say "same measure, other strand". Bars carry
    // that as a lighter fill, since a bar has no dash to give.
    const seriesAlpha = metadata?.lineStyle === 'dashed' ? 0.55 : 1;
    const channel = mutantOverlay?.channelBySeries[seriesIndex] ?? null;
    // A series the hovered mutation says nothing about steps back while it is up.
    context.globalAlpha = seriesAlpha * (mutantOverlay && channel === null ? 0.4 : 1);

    // With a column layout the row is in the modified sequence's geometry, so
    // a feature is placed by the column it belongs to -- including inserted
    // bases, which have no coordinate to be placed by otherwise. Every bar spans
    // its whole base. Splitting the base between the series put each channel
    // half a base off its own coordinate, which is exactly the offset that stops
    // a call lining up with the exon edge it belongs to. Two channels calling
    // the same base overlap; being able to read a bar against the annotation is
    // worth more than telling them apart there.
    const placeBar = (feature: TrackFeature): { x: number; width: number } | null => {
      const columnIndex = columnLayout
        ? feature.insertionBefore !== undefined
          ? columnLayout.indexOfInsertion(feature.insertionBefore, feature.insertionOffset ?? 0)
          : columnLayout.indexOfBase(feature.start)
        : -1;
      if (columnLayout && columnIndex < 0) {
        return null;
      }
      return columnLayout
        ? { x: columnIndex * columnLayout.columnWidth * widthPx, width: Math.max(1, columnLayout.columnWidth * widthPx) }
        : { x: (feature.start - startBp) / bpPerPx, width: Math.max(1, (feature.end - feature.start) / bpPerPx) };
    };

    if (!mutantOverlay || channel === null) {
      context.beginPath();
      for (const feature of seriesFeatures) {
        const place = placeBar(feature);
        if (!place) {
          continue;
        }
        const valueY = yForScore(feature.score);
        if (Math.abs(valueY - baseline) < Number.EPSILON) {
          continue;
        }
        context.rect(place.x, Math.min(valueY, baseline), place.width, Math.max(1, Math.abs(valueY - baseline)));
      }
      context.fill();
      return;
    }

    // Under a hovered ISM base, the row shows what the mean of its three
    // mutants predicts, as its ordinary bars; the original stands over it,
    // translucent and outlined; and an arrow runs from the original to the
    // mutant wherever the mutation moved the prediction. Down is a site lost,
    // up a site gained, the length is the change on the row's own axis.
    const bars: { x: number; width: number; originalY: number; mutantY: number; moved: boolean }[] = [];
    for (const feature of seriesFeatures) {
      const place = placeBar(feature);
      if (!place) {
        continue;
      }
      const mutant = overlayMutantValue(mutantOverlay, channel, feature);
      bars.push({
        x: place.x,
        width: place.width,
        originalY: yForScore(feature.score),
        mutantY: yForScore(mutant ?? feature.score),
        moved: mutant !== null && Math.abs(mutant - feature.score) >= MUTANT_OVERLAY_MIN_CHANGE,
      });
    }
    context.globalAlpha = seriesAlpha;
    context.beginPath();
    for (const bar of bars) {
      if (Math.abs(bar.mutantY - baseline) < Number.EPSILON) {
        continue;
      }
      context.rect(bar.x, Math.min(bar.mutantY, baseline), bar.width, Math.max(1, Math.abs(bar.mutantY - baseline)));
    }
    context.fill();
    // The original: only where it stands clear of the baseline, or every
    // near-zero base would grow an outline.
    context.beginPath();
    for (const bar of bars) {
      if (Math.abs(bar.originalY - baseline) < 1.5) {
        continue;
      }
      context.rect(
        bar.x + 0.5,
        Math.min(bar.originalY, baseline) + 0.5,
        Math.max(1, bar.width - 1),
        Math.max(1, Math.abs(bar.originalY - baseline) - 1),
      );
    }
    context.globalAlpha = seriesAlpha * 0.28;
    context.fill();
    context.globalAlpha = seriesAlpha * 0.8;
    context.stroke();
    context.globalAlpha = 1;
    context.strokeStyle = palette.ink;
    context.fillStyle = palette.ink;
    context.lineWidth = 1.25;
    for (const bar of bars) {
      if (bar.moved) {
        drawChangeArrow(context, bar.x + bar.width / 2, bar.originalY, bar.mutantY, clamp(bar.width * 0.35, 2, 5));
      }
    }
  });
  context.globalAlpha = 1;
  }

  context.restore();

  if (mutantOverlay && mutantOverlay.channelBySeries.some((channel) => channel !== null)) {
    drawMutantMarker(context, mutantOverlay, startBp, bpPerPx, widthPx, columnLayout, plotTop, plotBottom, palette);
  }

  if (hoverX === null) {
    return;
  }

  const boundedHoverX = clamp(hoverX, 0, widthPx);
  // Snap to the tallest bar within reach of the cursor. At base resolution a
  // single bar is a couple of pixels wide, so asking the reader to land exactly
  // on one -- and reporting whatever sits under the pixel otherwise -- makes the
  // readout hardest to get exactly where the peaks are worth reading.
  const featureCenterX = (feature: TrackFeature) =>
    columnLayout
      ? (((feature.insertionBefore !== undefined
          ? columnLayout.indexOfInsertion(feature.insertionBefore, feature.insertionOffset ?? 0)
          : columnLayout.indexOfBase(feature.start)) +
          0.5) *
          columnLayout.columnWidth) *
        widthPx
      : ((feature.start + feature.end) * 0.5 - startBp) / bpPerPx;

  let hovered: { feature: TrackFeature; seriesIndex: number; x: number } | null = null;
  let bestScore = -Infinity;

  for (const feature of shownFeatures) {
    const x = featureCenterX(feature);
    if (Math.abs(x - boundedHoverX) > HOVER_SNAP_RADIUS_PX) {
      continue;
    }
    const magnitude = Math.abs(feature.score);
    if (magnitude <= bestScore) {
      continue;
    }
    const rawIndex = Number.isInteger(feature.seriesIndex) ? (feature.seriesIndex as number) : 0;
    bestScore = magnitude;
    hovered = { feature, seriesIndex: clamp(rawIndex, 0, Math.max(0, series.length - 1)), x };
  }

  const guideX = hovered ? hovered.x : boundedHoverX;
  drawHoverGuide(context, guideX, plotTop - 2, plotBottom + 2, palette);

  if (!hovered) {
    return;
  }

  const metadata = series[hovered.seriesIndex];
  const seriesPrefix = series.length > 1 && metadata ? `${metadata.name} · ` : '';
  const position = hovered.feature.insertionBefore !== undefined
    ? `inserted @ ${formatPosition(hovered.feature.insertionBefore)}`
    : formatPosition(Math.floor(hovered.feature.start));
  // Name the dinucleotide under the call, so an antisense hit (AC/CT) reads as
  // one instead of looking like a non-canonical site.
  const motif = motifFor(hovered.feature);
  const motifSuffix = motif ? ` · ${formatSpliceMotif(motif)}` : '';
  const otherStrand = geneOnOtherStrand(hovered.feature);
  const strandNote = otherStrand ? ` · gene on the ${otherStrand} strand: flip the strand to score it` : '';
  // On a −log(1−p) axis three decimals print 0.99 and 0.99999 alike, which is
  // the very difference the axis is there to show.
  const valueText = scaleShape === 'complement-log'
    ? formatProbabilityNines(hovered.feature.score)
    : hovered.feature.score.toFixed(3);
  const label = `${seriesPrefix}${valueText} @ ${position}${motifSuffix}${strandNote}`;
  drawHoverLabel(context, label, guideX, widthPx, plotTop + 1, palette);
}

function drawSequenceSignal(
  context: CanvasRenderingContext2D,
  columns: readonly SequenceSignalColumn[],
  renderMode: Exclude<SequenceSignalRenderMode, 'signal'>,
  chr: string,
  startBp: number,
  bpPerPx: number,
  widthPx: number,
  heightPx: number,
  hoverX: number | null,
  palette: ViewportPalette,
  domain: SignalDomain,
  scaleShape: SignalScaleShape,
  columnLayout: SequenceColumnLayout | null = null,
): void {
  const plotPadding = clamp(heightPx * 0.12, 2, 10);
  // With insertions open, a base's x comes from its column rather than the
  // linear bp scale, so the glyph stays under the letter in the row above.
  const colPx = columnLayout ? columnLayout.columnWidth * widthPx : 0;
  const baseX = (bp: number): number => {
    if (!columnLayout) return (bp - startBp) / bpPerPx;
    const index = columnLayout.indexOfBase(bp);
    return index < 0 ? (bp - startBp) / bpPerPx : index * colPx;
  };
  const baseW = (startBpOf: number, endBpOf: number): number =>
    columnLayout ? colPx : (endBpOf - startBpOf) / bpPerPx;
  const plotTop = plotPadding;
  const plotBottom = heightPx - plotPadding;
  const geometryAtZero = computeSignalBarGeometry(0, domain, plotTop, plotBottom, scaleShape);
  if (!geometryAtZero) {
    return;
  }

  const baseline = geometryAtZero.baselineY;
  context.strokeStyle = palette.axis;
  context.lineWidth = 1;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(0, Math.round(baseline) + 0.5);
  context.lineTo(widthPx, Math.round(baseline) + 0.5);
  context.stroke();

  context.save();
  context.beginPath();
  context.rect(0, plotTop, widthPx, plotBottom - plotTop);
  context.clip();

  for (const column of columns) {
    const geometry = computeSignalBarGeometry(
      column.feature.score,
      domain,
      plotTop,
      plotBottom,
      scaleShape,
    );
    if (!geometry || geometry.direction === 'zero' || geometry.height < Number.EPSILON) {
      continue;
    }

    const x = baseX(column.feature.start);
    const rawWidth = baseW(column.feature.start, column.feature.end);
    const { width } = computeSequenceGlyphFit(rawWidth, 1);
    const left = x + (rawWidth - width) * 0.5;
    if (left + width < 0 || left > widthPx) {
      continue;
    }
    const base = column.base as keyof ViewportPalette['base'];
    const color = palette.base[base] ?? palette.base.N;

    // In letters mode every base is a letter, however small its value: a row
    // that mixed letters with bars for the weak bases read as two encodings.
    // Colour alone tells the bases apart when a glyph is squashed to a sliver.
    if (renderMode === 'cells') {
      context.fillStyle = color;
      context.globalAlpha = 0.9;
      context.fillRect(left, geometry.y, width, Math.max(1, geometry.height));
      context.globalAlpha = 1;
      continue;
    }

    // A real sequence-logo glyph: width remains fitted to its genomic base,
    // while its upright height is exactly the signed signal distance from zero.
    context.save();
    context.beginPath();
    context.rect(left, geometry.y, width, geometry.height);
    context.clip();
    context.fillStyle = color;
    context.font = '800 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textAlign = 'center';
    // On the minus strand the row is mirrored and reads that strand 5'->3', so
    // the glyph shows the complement and is un-mirrored so it is legible. The
    // bar geometry above is untouched: it already lands under the right base.
    const mirrored = context.getTransform().a < 0;
    const glyph = mirrored ? complementBase(column.base) : column.base;
    const measuredWidth = Math.max(1, context.measureText(glyph).width);
    const { scaleX } = computeSequenceGlyphFit(rawWidth, measuredWidth);
    // At least a 2px sliver, so a near-zero base still shows its colour.
    const scaleY = Math.max(0.2, geometry.height / 10);
    context.translate(left + width * 0.5, geometry.baselineY);
    context.scale(mirrored ? -scaleX : scaleX, scaleY);
    context.textBaseline = geometry.direction === 'positive' ? 'alphabetic' : 'top';
    context.fillText(glyph, 0, 0);
    context.restore();
  }
  context.restore();

  if (hoverX === null) {
    return;
  }

  const boundedHoverX = clamp(hoverX, 0, widthPx);
  const hoverBp = makeXToBp(columnLayout, startBp, bpPerPx, widthPx)(boundedHoverX);
  const hovered = columns.find(
    (column) => hoverBp >= column.feature.start && hoverBp < column.feature.end,
  );
  drawHoverGuide(context, boundedHoverX, plotTop - 2, plotBottom + 2, palette);
  if (!hovered) {
    return;
  }

  const value = hovered.feature.score;
  // The letter named is the one drawn: on the minus strand the glyphs show the
  // complement, and so must the label, or the base reads T here and A in the
  // mutant legend on the plot above.
  const hoveredBase = context.getTransform().a < 0 ? complementBase(hovered.base) : hovered.base;
  // A mutagenesis base names the largest change the mean of its three mutants
  // makes, from what to what and where; every prediction track of the model
  // shows the whole of it while the pointer is here.
  const effect = hovered.feature.mutantEffect;
  const label = effect
    ? `${hoveredBase} · ISM ${value.toFixed(2)} · ${describeMutantEffect(effect)} @ ${chr}:${formatPosition(hovered.position)}`
    : `${hoveredBase} · ${
        scaleShape === 'complement-log' && value >= 0
          ? formatProbabilityNines(value)
          : `${value < 0 ? '−' : ''}${Math.abs(value).toPrecision(4)}`
      } @ ${chr}:${formatPosition(hovered.position)}`;
  drawHoverLabel(context, label, boundedHoverX, widthPx, plotTop + 1, palette);
}

function bpToX(position: number, startBp: number, bpPerPx: number): number {
  return (position - startBp) / bpPerPx;
}

/**
 * Where a coordinate sits once insertions have widened the row.
 *
 * Annotations have to travel with the sequence above them: if the reference
 * opens a gap for inserted bases, an exon boundary drawn on the raw bp scale
 * would slide out from under the base it belongs to.
 */
/**
 * Inverse of makeBpToX: the genomic position under an x. With columns open, an
 * x over an inserted column resolves to the base it precedes, so hovering an
 * insertion names the neighbouring genomic base rather than a coordinate the
 * genome does not have. Without this the hover used the linear scale and
 * reported the wrong base as soon as any insertion was on screen.
 */
function makeXToBp(
  layout: SequenceColumnLayout | null,
  startBp: number,
  bpPerPx: number,
  widthPx: number,
): (x: number) => number {
  if (!layout) {
    return (x: number) => startBp + x * bpPerPx;
  }
  const columnPx = layout.columnWidth * widthPx;
  return (x: number) => {
    const index = Math.floor(x / columnPx);
    const column = layout.columns[Math.max(0, Math.min(layout.columns.length - 1, index))];
    if (!column) return startBp;
    if (column.kind === 'insertion') return column.before;
    return column.genomic + (x / columnPx - index);
  };
}

function makeBpToX(
  layout: SequenceColumnLayout | null,
  startBp: number,
  bpPerPx: number,
  widthPx: number,
): (position: number) => number {
  if (!layout) {
    return (position: number) => bpToX(position, startBp, bpPerPx);
  }

  const columnPx = layout.columnWidth * widthPx;
  return (position: number) => {
    const whole = Math.floor(position);
    const index = layout.indexOfBase(whole);
    if (index >= 0) {
      return (index + (position - whole)) * columnPx;
    }
    // Outside the laid-out window: fall back to the linear scale, shifted by the
    // columns the window has gained, so the geometry still meets at the edges.
    const linear = bpToX(position, startBp, bpPerPx);
    return position < startBp ? linear : linear + (layout.columns.length - (widthPx / columnPx)) * columnPx;
  };
}

function fillBpRect(
  context: CanvasRenderingContext2D,
  start: number,
  end: number,
  toX: (position: number) => number,
  y: number,
  height: number,
): void {
  if (end <= start || height <= 0) {
    return;
  }
  const x = toX(start);
  const w = Math.max(1, toX(end) - x);
  context.fillRect(x, y, w, height);
}

/**
 * How far the hover readout reaches for a bar. Wide enough that a peak can be
 * pointed at rather than hit exactly, narrow enough not to cross to a neighbour
 * the reader was not asking about.
 */
const HOVER_SNAP_RADIUS_PX = 6;

/** Spacing between strand chevrons along a transcript, in pixels. */
const STRAND_ARROW_SPACING_PX = 34;
const STRAND_ARROW_HALF_WIDTH_PX = 2.4;

/**
 * Mark which way a transcript is read.
 *
 * Chevrons are drawn along the whole body rather than only over introns, and
 * switch to the row background where they cross an exon, so the direction stays
 * legible on a solid block and on a bare backbone alike.
 */
function drawStrandArrows(
  context: CanvasRenderingContext2D,
  feature: TrackFeature,
  color: string,
  backgroundColor: string,
  toX: (position: number) => number,
  midY: number,
  laneHeight: number,
  widthPx: number,
): void {
  const strand = feature.strand;
  if (strand !== '+' && strand !== '-') {
    return;
  }

  const left = toX(feature.start);
  const right = toX(feature.end);
  if (right - left < STRAND_ARROW_SPACING_PX * 0.6) {
    return;
  }

  const exons = feature.exons?.filter((exon) => exon.end > exon.start) ?? [];
  const half = Math.min(STRAND_ARROW_HALF_WIDTH_PX, Math.max(1.5, laneHeight * 0.22));
  const direction = strand === '+' ? 1 : -1;

  // Start half a step in so an arrow never sits on the transcript end cap.
  const firstX = left + STRAND_ARROW_SPACING_PX * 0.5;
  context.lineWidth = 1.2;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  for (let x = firstX; x < right; x += STRAND_ARROW_SPACING_PX) {
    if (x < -half || x > widthPx + half) {
      continue;
    }

    const overExon = exons.some((exon) => x >= toX(exon.start) && x <= toX(exon.end));
    context.strokeStyle = overExon ? backgroundColor : color;
    context.beginPath();
    context.moveTo(x - half * direction, midY - half);
    context.lineTo(x + half * direction, midY);
    context.lineTo(x - half * direction, midY + half);
    context.stroke();
  }
}

/**
 * Draw a transcript/gene body: thin intron backbone across the span, thicker exon
 * boxes, and full-height coding segments when CDS bounds are present.
 */
function drawAnnotationBody(
  context: CanvasRenderingContext2D,
  feature: TrackFeature,
  color: string,
  backgroundColor: string,
  toX: (position: number) => number,
  y: number,
  laneHeight: number,
  widthPx: number,
): void {
  context.fillStyle = color;
  const exons = feature.exons?.filter((exon) => exon.end > exon.start) ?? [];
  const midY = y + laneHeight * 0.5;
  const intronHeight = Math.max(1, Math.min(2.5, laneHeight * 0.18));
  const utrHeight = Math.max(3, laneHeight * 0.55);
  const cdsHeight = laneHeight;

  // Intron / transcript backbone (also covers gaps between exons).
  fillBpRect(context, feature.start, feature.end, toX, midY - intronHeight * 0.5, intronHeight);

  if (exons.length === 0) {
    fillBpRect(context, feature.start, feature.end, toX, y, laneHeight);
    drawStrandArrows(
      context,
      feature,
      color,
      backgroundColor,
      toX,
      midY,
      laneHeight,
      widthPx,
    );
    return;
  }

  const cdsStart = feature.cdsStart;
  const cdsEnd = feature.cdsEnd;
  const hasCds =
    Number.isFinite(cdsStart) &&
    Number.isFinite(cdsEnd) &&
    (cdsEnd as number) > (cdsStart as number);

  for (const exon of exons) {
    if (!hasCds) {
      fillBpRect(context, exon.start, exon.end, toX,
        midY - utrHeight * 0.5,
        utrHeight,
      );
      continue;
    }

    const codingStart = Math.max(exon.start, cdsStart as number);
    const codingEnd = Math.min(exon.end, cdsEnd as number);

    if (exon.start < codingStart) {
      fillBpRect(
        context,
        exon.start,
        Math.min(exon.end, codingStart),
        toX,
        midY - utrHeight * 0.5,
        utrHeight,
      );
    }
    if (codingEnd > codingStart) {
      fillBpRect(context, codingStart, codingEnd, toX,
        midY - cdsHeight * 0.5,
        cdsHeight,
      );
    }
    if (exon.end > codingEnd) {
      fillBpRect(
        context,
        Math.max(exon.start, codingEnd),
        exon.end,
        toX,
        midY - utrHeight * 0.5,
        utrHeight,
      );
    }
  }

  drawStrandArrows(
    context,
    feature,
    color,
    backgroundColor,
    toX,
    midY,
    laneHeight,
    widthPx,
  );
}

/** What an annotation draw needed and did, for the row's height controls. */
type AnnotationLanesReport = {
  mode: AnnotationDrawMode;
  /** Lanes the visible transcripts pack into. */
  laneCount: number;
  /** Lanes the row drew, and the first of them. */
  drawnLanes: number;
  laneOffset: number;
  hidden: number;
  geneHeaderPx: number;
};

function drawAnnotation(
  context: CanvasRenderingContext2D,
  features: TrackFeature[],
  startBp: number,
  bpPerPx: number,
  widthPx: number,
  heightPx: number,
  color: string,
  hoverX: number | null,
  hoverY: number | null,
  palette: ViewportPalette,
  columnLayout: SequenceColumnLayout | null,
  /** The first lane to draw, for a row grown past the height cap. */
  laneOffset = 0,
  /** A row that can be grown draws its hidden note as an offer. */
  growable = false,
): AnnotationLanesReport | null {
  const toX = makeBpToX(columnLayout, startBp, bpPerPx, widthPx);
  const viewEndBp = startBp + widthPx * bpPerPx;
  const visibleFeatures: PositionedAnnotationFeature[] = [];

  for (const feature of features) {
    if (feature.end < startBp || feature.start > viewEndBp) {
      continue;
    }

    const x = toX(feature.start);
    visibleFeatures.push({
      feature,
      x,
      w: Math.max(1.5, toX(feature.end) - x),
      lane: 0,
    });
  }

  if (visibleFeatures.length === 0) {
    return null;
  }

  const hasDensitySummary = visibleFeatures.some(
    (item) => item.feature.renderMode === 'density',
  );
  const mode = chooseAnnotationMode(visibleFeatures.length, bpPerPx, hasDensitySummary);

  if (mode === 'density') {
    const binCount = Math.max(1, Math.floor(widthPx));
    const diff = new Float32Array(binCount + 1);

    for (const item of visibleFeatures) {
      // Same tiling rule as computeAnnotationScaleInfo: round both edges, or
      // adjacent summary bins double-count their shared boundary pixel.
      const startBin = clamp(Math.round(item.x), 0, binCount - 1);
      const endBinExclusive = clamp(Math.round(item.x + item.w), 1, binCount);
      const boundedEnd = endBinExclusive <= startBin ? Math.min(binCount, startBin + 1) : endBinExclusive;
      const weight = item.feature.renderMode === 'density' ? Math.max(0, item.feature.score) : 1;
      diff[startBin] += weight;
      diff[boundedEnd] -= weight;
    }

    const bins = new Float32Array(binCount);
    let value = 0;
    let maxValue = 0;
    for (let index = 0; index < binCount; index += 1) {
      value += diff[index];
      bins[index] = value;
      if (value > maxValue) {
        maxValue = value;
      }
    }

    if (maxValue <= 0) {
      return null;
    }

    const plotTop = 8;
    const baseline = heightPx - 8;
    const maxHeight = Math.max(4, baseline - plotTop);

    context.fillStyle = color;
    for (let index = 0; index < binCount; index += 1) {
      const normalized = bins[index] / maxValue;
      const barHeight = Math.max(1, normalized * maxHeight);
      context.fillRect(index, baseline - barHeight, 1, barHeight);
    }

    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'top';
    context.fillStyle = palette.valueLabel;
    const summaryLabel = `${hasDensitySummary ? 'summary' : 'density'} · ${visibleFeatures.length.toLocaleString()}`;
    cornerNote(context, summaryLabel, widthPx);

    if (hoverX !== null) {
      const boundedHoverX = clamp(hoverX, 0, widthPx);
      const hoverBin = clamp(Math.floor(boundedHoverX), 0, binCount - 1);
      const hoverValue = bins[hoverBin];
      const hoverBp = startBp + boundedHoverX * bpPerPx;
      const valueText =
        hoverValue >= 100 ? hoverValue.toFixed(0) : hoverValue >= 10 ? hoverValue.toFixed(1) : hoverValue.toFixed(2);
      drawHoverGuide(context, boundedHoverX, plotTop - 2, baseline + 2, palette);
      drawHoverLabel(context, `${valueText} density @ ${formatPosition(hoverBp)}`, boundedHoverX, widthPx, plotTop + 1, palette);
    }
    return null;
  }

  const hasExplicitLane = visibleFeatures.some((item) => Number.isFinite(item.feature.lane));
  let laneCount = 0;
  const collisionGapPx = 2;

  if (hasExplicitLane) {
    let minLane = Number.POSITIVE_INFINITY;
    let maxLane = Number.NEGATIVE_INFINITY;

    for (const item of visibleFeatures) {
      const rawLane = Number.isFinite(item.feature.lane) ? Math.floor(item.feature.lane as number) : 0;
      item.lane = Math.max(0, rawLane);
      minLane = Math.min(minLane, item.lane);
      maxLane = Math.max(maxLane, item.lane);
    }

    if (Number.isFinite(minLane) && minLane > 0) {
      for (const item of visibleFeatures) {
        item.lane -= minLane;
      }
      maxLane -= minLane;
    }

    laneCount = Math.max(1, maxLane + 1);
  } else {
    // Representative transcripts pack as their own group ahead of everything
    // else, so they take the top lanes whatever strand they are on -- otherwise a
    // minus-strand MANE transcript sits below every plus-strand alternate.
    const primary: PositionedAnnotationFeature[] = [];
    const positiveStrand: PositionedAnnotationFeature[] = [];
    const neutralStrand: PositionedAnnotationFeature[] = [];
    const negativeStrand: PositionedAnnotationFeature[] = [];

    for (const item of visibleFeatures) {
      if (item.feature.emphasis === 'primary') {
        primary.push(item);
      } else if (item.feature.strand === '+') {
        positiveStrand.push(item);
      } else if (item.feature.strand === '-') {
        negativeStrand.push(item);
      } else {
        neutralStrand.push(item);
      }
    }

    const groups = [primary, positiveStrand, neutralStrand, negativeStrand].filter(
      (group) => group.length > 0,
    );
    for (const group of groups) {
      group.sort((left, right) => left.x - right.x);
      laneCount += packOverlappingFeatures(group, laneCount, collisionGapPx);
    }

    laneCount = Math.max(1, laneCount);
  }

  // Gene names take a header line. Whether there are any is known before the
  // lanes are laid out, and the lanes that fit depend on what is left under it.
  const mirrored = context.getTransform().a < 0;
  const hasGeneLabels = visibleFeatures.some(({ feature }) => feature.transcriptId && feature.label);
  const geneHeaderHeight = hasGeneLabels ? ANNOTATION_LABEL_FONT_PX + 5 : 0;

  // How many lanes this row draws. At its default height that is the fixed cap
  // for the mode; a row the reader has grown draws as many as fit at a readable
  // pitch, from the lane its window starts at, and the wheel over it moves the
  // window. Growing never squeezes the lanes thinner; it shows more of them.
  const laneCap = mode === 'full' ? ANNOTATION_MAX_LANES_FULL : ANNOTATION_MAX_LANES_SQUISH;
  const renderLaneCount = Math.max(1, Math.min(laneCount, Math.max(laneCap, annotationLanesThatFit(heightPx, geneHeaderHeight))));
  const firstLane = clampLaneOffset(laneOffset, laneCount, renderLaneCount);
  for (const item of visibleFeatures) {
    item.lane -= firstLane;
  }
  const hiddenByLane = visibleFeatures.filter((item) => item.lane < 0 || item.lane >= renderLaneCount).length;
  const windowed = firstLane > 0 || firstLane + renderLaneCount < laneCount;
  // The note names what is hidden and, on a row that can grow, what to do about
  // it: click to fit while growing would help, scroll once it is at its cap.
  const offer = !growable || hiddenByLane === 0 ? '' : windowed && renderLaneCount > laneCap ? ' · scroll' : ' · click to fit';
  const modeLabel = mode === 'squish' || hiddenByLane > 0
    ? `squish${hiddenByLane > 0 ? ` · +${hiddenByLane.toLocaleString()} hidden` : ''}${offer}` : '';
  context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const noteInset = modeLabel ? context.measureText(modeLabel).width + 16 : 4;
  context.font = `${ANNOTATION_LABEL_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const geneLabels = layoutAnnotationGeneLabels(
    visibleFeatures.flatMap(({ feature, x, w }) => feature.transcriptId && feature.label
      ? [{ name: feature.label, startPx: x, endPx: x + w }] : []),
    widthPx, (name) => context.measureText(name).width, mirrored, noteInset,
  );
  context.textBaseline = 'top';
  const report: AnnotationLanesReport = {
    mode, laneCount, drawnLanes: renderLaneCount, laneOffset: firstLane, hidden: hiddenByLane, geneHeaderPx: geneHeaderHeight,
  };
  context.fillStyle = palette.ink;
  for (const label of geneLabels) upright(context, label.name, label.x, 3);
  const laneGeometry = annotationLaneGeometry(heightPx - geneHeaderHeight, renderLaneCount);
  const { laneSpan, laneHeight } = laneGeometry;
  const firstLaneY = laneGeometry.firstLaneY + geneHeaderHeight;
  const labelGapPx = 8;
  const lanesFitLabels = annotationLanesFitLabels(laneSpan);
  const lastLabelRightByLane = new Map<number, number>();
  const orderedFeatures = [...visibleFeatures].sort((left, right) => left.lane - right.lane || left.x - right.x);
  let drawnLabels = 0;

  context.font = `${ANNOTATION_LABEL_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = 'middle';

  for (const [index, positioned] of orderedFeatures.entries()) {
    const { feature, lane, x, w } = positioned;
    if (lane < 0 || lane >= renderLaneCount) {
      continue;
    }

    const y = firstLaneY + lane * laneSpan;
    // The representative transcript is the one a reader is looking for: it keeps
    // full height and the strongest ink, while the alternates around it are
    // squished and greyed so they read as context rather than competition.
    const isSecondary = feature.emphasis === 'secondary';
    const featureColor =
      feature.emphasis === 'primary' ? palette.ink : isSecondary ? palette.inkSoft : color;
    const featureHeight = isSecondary ? Math.max(3, laneHeight * 0.34) : laneHeight;
    const featureY = y + (laneHeight - featureHeight) * 0.5;
    drawAnnotationBody(
      context,
      feature,
      featureColor,
      palette.bg,
      toX,
      featureY,
      featureHeight,
      widthPx,
    );

    if (
      feature.transcriptId ||
      mode !== 'full' ||
      !lanesFitLabels ||
      drawnLabels >= ANNOTATION_MAX_LABELS ||
      !feature.label
    ) {
      continue;
    }

    const labelWidth = context.measureText(feature.label).width;
    const laneLastRight = lastLabelRightByLane.get(lane) ?? Number.NEGATIVE_INFINITY;
    const previous = orderedFeatures[index - 1];
    const next = orderedFeatures[index + 1];
    const leftBound = Math.max(4, laneLastRight + labelGapPx,
      previous?.lane === lane ? previous.x + previous.w + labelGapPx : 4);
    const rightBound = Math.min(widthPx - 4, next?.lane === lane ? next.x - labelGapPx : widthPx - 4);
    const before = x - labelGapPx - labelWidth;
    const after = x + w + labelGapPx;
    // Prefer the screen-left flank, including when the sequence is mirrored.
    // Names occupy empty space, never exons or the transcript's direction line.
    let labelLeft = (mirrored ? [after, before] : [before, after])
      .find((candidate) => candidate >= leftBound && candidate + labelWidth <= rightBound);
    let labelY = y + laneHeight * 0.5;
    if (labelLeft === undefined && (laneSpan - laneHeight) * 0.5 >= ANNOTATION_LABEL_FONT_PX + 3) {
      const visibleLeft = Math.max(4, x, laneLastRight + labelGapPx);
      const visibleRight = Math.min(widthPx - 4, x + w);
      if (visibleRight - visibleLeft >= labelWidth) {
        labelLeft = mirrored ? visibleRight - labelWidth : visibleLeft;
        labelY = y - 3 - ANNOTATION_LABEL_FONT_PX * 0.5;
      }
    }
    if (labelLeft === undefined) continue;

    context.fillStyle = palette.ink;
    upright(context, feature.label, labelLeft, labelY);
    drawnLabels += 1;

    lastLabelRightByLane.set(lane, labelLeft + labelWidth);
  }

  if (modeLabel) {
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'top';
    context.fillStyle = palette.valueLabel;
    cornerNote(context, modeLabel, widthPx);
  }

  if (hoverX === null) {
    return report;
  }

  const boundedHoverX = clamp(hoverX, 0, widthPx);
  const hoverBp = makeXToBp(columnLayout, startBp, bpPerPx, widthPx)(boundedHoverX);
  let hoveredFeature: PositionedAnnotationFeature | null = null;
  const laneTop = firstLaneY;
  const laneBottom = firstLaneY + laneSpan * renderLaneCount;
  const hoverLane =
    hoverY !== null && hoverY >= laneTop && hoverY <= laneBottom
      ? Math.floor((hoverY - firstLaneY) / laneSpan)
      : null;

  for (const positioned of visibleFeatures) {
    if (positioned.lane < 0 || positioned.lane >= renderLaneCount) {
      continue;
    }
    if (hoverBp < positioned.feature.start || hoverBp > positioned.feature.end) {
      continue;
    }
    if (hoverLane !== null && positioned.lane !== hoverLane) {
      continue;
    }
    if (!hoveredFeature || positioned.w < hoveredFeature.w) {
      hoveredFeature = positioned;
    }
  }

  if (!hoveredFeature && hoverLane !== null) {
    for (const positioned of visibleFeatures) {
      if (positioned.lane < 0 || positioned.lane >= renderLaneCount) {
        continue;
      }
      if (hoverBp < positioned.feature.start || hoverBp > positioned.feature.end) {
        continue;
      }
      if (!hoveredFeature || positioned.w < hoveredFeature.w) {
        hoveredFeature = positioned;
      }
    }
  }

  drawHoverGuide(context, boundedHoverX, 6, heightPx - 6, palette);

  if (!hoveredFeature) {
    return report;
  }

  const { feature } = hoveredFeature;
  const name = feature.label ?? 'feature';
  // The row shows the gene; the transcript it belongs to is here for the asking.
  const transcript = feature.transcriptId && feature.transcriptId !== feature.label ? ` · ${feature.transcriptId}` : '';
  const strand = feature.strand && feature.strand !== '.' ? ` ${feature.strand}` : '';
  const exonCount = feature.exons?.length ?? 0;
  const exonText = exonCount > 0 ? ` · ${exonCount} exon${exonCount === 1 ? '' : 's'}` : '';
  const label = `${name}${transcript}${strand}${exonText} · ${formatRange(feature.start, feature.end)}`;
  drawHoverLabel(context, label, boundedHoverX, widthPx, 3, palette);
  return report;
}

export const TrackRowCanvas = memo(function TrackRowCanvas({
  track,
  selected,
  onSelect,
  grouping,
  viewport,
  windowSpec,
  genome,
  onSignalDisplayChange,
  onSignalScaleShapeChange,
  onPlotGroupingChange,
  onHideOnEdited,
  onHeightChange,
  columnEdits,
  reversed = false,
}: TrackRowCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { data, loading, error, stale, partial } = useTrackWindowData(track, viewport, windowSpec);
  const signalSeries = useMemo<SignalSeriesMetadata[]>(() => {
    if (track.source.type === 'group') {
      return track.source.members.map((member) => ({
        id: member.id,
        name: member.name,
        color: member.color,
        lineStyle: 'solid' as const,
      }));
    }
    if (track.source.type !== 'computational') {
      return [{
        id: track.id,
        name: track.name,
        color: track.color,
        lineStyle: 'solid',
      }];
    }
    const source = track.source;
    return resolveComputationalTrackSubtracks(source).map((subtrack) => ({
      id: subtrack.id,
      name: subtrack.name,
      color: subtrack.color,
      lineStyle: resolveComputationalSeriesLineStyle(source, subtrack),
    }));
  }, [track]);
  const boundedRange = useMemo(
    () => clampRangeToChromosome(viewport.range, viewport.chrLength),
    [viewport.chrLength, viewport.range],
  );
  const requestedSignalDisplay = track.signalDisplay ?? 'signal';
  const scaleShape: SignalScaleShape = resolveSignalScaleShape(track);
  // The chip cycles the general shapes, then whatever this track's config
  // enables (−log(1−p) on a probability output).
  const nextScaleShape = nextSignalScaleShapeFor(track);
  // Every row shares its geometry with the sequence above it. An insertion
  // widens the row, so bp-to-pixel stops being linear for annotations and data
  // alike, not only for the model outputs -- an exon boundary drawn on the raw
  // bp scale slides out from under the base it belongs to.
  //
  // Only while the sequence row is drawing one cell per base. Past that it bins
  // into a composition summary and there is no gap to line up with.
  const editedColumnLayout = useMemo<SequenceColumnLayout | null>(() => {
    if (!columnEdits || columnEdits.length === 0) {
      return null;
    }
    if (!rowHasPerBaseColumns(boundedRange.end - boundedRange.start, viewport.widthPx)) {
      return null;
    }
    const layout = buildSequenceColumnLayout(columnEdits, boundedRange.start, boundedRange.end);
    return layoutIsLinear(layout) ? null : layout;
  }, [boundedRange.end, boundedRange.start, columnEdits, viewport.widthPx]);
  const sequenceDisplayRequested =
    track.kind === 'signal' && requestedSignalDisplay === 'sequence' && signalSeries.length === 1;
  const plannedSequenceRenderMode = useMemo<SequenceSignalRenderMode>(
    () => sequenceDisplayRequested
      ? chooseSequenceSignalRenderMode(
          viewport.bpPerPx,
          data?.spec.resolutionBp ?? windowSpec.resolutionBp,
          signalSeries.length,
          data?.features ?? [],
        )
      : 'signal',
    [
      data?.features,
      data?.spec,
      sequenceDisplayRequested,
      signalSeries.length,
      viewport.bpPerPx,
      windowSpec.resolutionBp,
    ],
  );
  const sequenceGenome = track.source.type === 'computational'
    ? track.source.pack.sequenceProvider.genome
    : genome;
  // The letter renderer needs the sequence to draw at all; a bar row needs it
  // only to name the dinucleotide a hovered call sits on, which is a question
  // worth asking exactly when the samples are one base each. The window is the
  // same one the reference strip already fetched, so this is a cache hit.
  const wantsMotifReadout =
    track.kind === 'signal' && signalSeries.length > 0 && windowSpec.resolutionBp <= 1;
  const referenceSequence = useReferenceSequenceWindow({
    genome: sequenceGenome,
    chr: viewport.chr,
    chrLength: viewport.chrLength,
    start: Math.floor(boundedRange.start),
    end: Math.ceil(boundedRange.end),
    enabled: plannedSequenceRenderMode !== 'signal' || wantsMotifReadout,
  });
  // An annotation row publishes where its genes are and which way they point;
  // a prediction row reads it back to tell a sense call from an antisense one.
  // Going through a registry rather than props is what lets the two rows stay
  // independently virtualized.
  const geneStrandKey = geneStrandCoverageKey(genome, viewport.chr);
  const geneStrandSpans = useMemo(
    () => (track.kind === 'signal' ? [] : geneStrandSpansFrom(data?.features ?? [])),
    [data?.features, track.kind],
  );

  useEffect(() => {
    if (geneStrandSpans.length === 0) {
      return;
    }
    return geneStrandRegistry.register(geneStrandKey, track.id, geneStrandSpans);
  }, [geneStrandKey, geneStrandSpans, track.id]);

  const subscribeGeneStrands = useCallback(
    (listener: () => void) => geneStrandRegistry.subscribe(geneStrandKey, listener),
    [geneStrandKey],
  );
  const readGeneStrandVersion = useCallback(
    () => geneStrandRegistry.version(geneStrandKey),
    [geneStrandKey],
  );
  const geneStrandVersion = useSyncExternalStore(
    subscribeGeneStrands,
    readGeneStrandVersion,
    readGeneStrandVersion,
  );
  const geneStrandCoverage = useMemo(() => {
    void geneStrandVersion;
    return track.kind === 'signal'
      ? geneStrandRegistry.read(geneStrandKey)
      : EMPTY_GENE_STRAND_COVERAGE;
  }, [geneStrandKey, geneStrandVersion, track.kind]);

  const sequenceColumns = useMemo(
    () => buildSequenceSignalColumns(
      (data?.features ?? []).filter((feature) => feature.insertionBefore === undefined),
      referenceSequence,
      boundedRange.start,
      boundedRange.end,
    ),
    [boundedRange.end, boundedRange.start, data?.features, referenceSequence],
  );
  // The DNA-height renderer places each glyph by its column, so a row carrying
  // insertions keeps its letters: genomic bases sit in their columns and the
  // inserted columns show as a gap, the same as every other track.
  const sequenceRenderMode: SequenceSignalRenderMode =
    plannedSequenceRenderMode !== 'signal' && sequenceColumns.length > 0
      ? plannedSequenceRenderMode
      : 'signal';
  const localSignalDomain = useMemo(
    () => computeVisibleSignalDomain(track, viewport, data?.features),
    [data?.features, track, viewport],
  );
  const linkedGroupId =
    track.kind === 'signal' && track.yScale?.mode === 'linked'
      ? track.yScale.groupId
      : null;
  const linkedViewportKey = useMemo(
    () => buildLinkedSignalViewportKey(viewport, windowSpec.resolutionBp),
    [viewport, windowSpec.resolutionBp],
  );
  const subscribeLinkedDomain = useCallback(
    (listener: () => void) => linkedGroupId
      ? linkedSignalDomainRegistry.subscribe(linkedGroupId, linkedViewportKey, listener)
      : () => undefined,
    [linkedGroupId, linkedViewportKey],
  );
  const getLinkedDomainVersion = useCallback(
    () => linkedGroupId
      ? linkedSignalDomainRegistry.version(linkedGroupId, linkedViewportKey)
      : 0,
    [linkedGroupId, linkedViewportKey],
  );
  const linkedDomainVersion = useSyncExternalStore(
    subscribeLinkedDomain,
    getLinkedDomainVersion,
    getLinkedDomainVersion,
  );

  useEffect(() => {
    if (!linkedGroupId || !localSignalDomain) {
      return;
    }
    return linkedSignalDomainRegistry.register(
      linkedGroupId,
      linkedViewportKey,
      track.id,
      localSignalDomain,
    );
  }, [linkedGroupId, linkedViewportKey, localSignalDomain, track.id]);

  const linkedSignalDomain = useMemo(() => {
    void linkedDomainVersion;
    return linkedGroupId
      ? linkedSignalDomainRegistry.read(linkedGroupId, linkedViewportKey)
      : null;
  }, [linkedDomainVersion, linkedGroupId, linkedViewportKey]);
  const effectiveSignalScale = useMemo(
    () => resolveEffectiveSignalScale(track, localSignalDomain, linkedSignalDomain),
    [linkedSignalDomain, localSignalDomain, track],
  );
  const usesSignedSignalScale = (effectiveSignalScale?.domain.min ?? 0) < 0;
  const scaleInfo = useMemo(
    () => {
      if (track.kind !== 'signal') {
        return computeAnnotationScaleInfo(viewport, data?.features);
      }
      if (!effectiveSignalScale) {
        return null;
      }
      return {
        topLabel: formatScaleValue(effectiveSignalScale.domain.max),
        bottomLabel: formatScaleValue(effectiveSignalScale.domain.min),
        kind: usesSignedSignalScale ? 'signed' as const : 'signal' as const,
        mode: effectiveSignalScale.mode,
        domain: effectiveSignalScale.domain,
        maxValue: localSignalDomain?.max ?? effectiveSignalScale.domain.max,
      };
    },
    [data?.features, effectiveSignalScale, localSignalDomain?.max, track.kind, usesSignedSignalScale, viewport],
  );
  // Genome-wide value context: local auto-scaling hides whether a region is high or
  // low, so rank the current auto-scale max against the whole chromosome.
  const distribution = useSignalDistribution(track, viewport.chr, windowSpec.resolutionBp);
  const distributionContextIsValid =
    track.kind === 'signal' &&
    track.source.type === 'bigwig' &&
    scaleInfo?.mode === 'auto' &&
    scaleInfo.kind === 'signal';
  // Split deliberately across three memos, keyed so that the expensive one does not
  // see the panning viewport.
  //
  // The ladder sweeps every window on the chromosome and sorts them -- up to ~30k
  // samples. It depends only on the distribution and the window WIDTH, both of which
  // are constant while panning; only the region's own mean moves. Keying it on
  // `viewport.range` rebuilt the whole ladder on every pan frame, per signal track,
  // which measured as ~70% of all main-thread work at base-pair zoom (~12fps).
  // `windowBins` is a primitive, so the ladder memo below stays stable across a pan
  // and only re-runs when the zoom actually changes the window width.
  const windowBins = useMemo(() => {
    if (!distributionContextIsValid || !distribution) {
      return null;
    }
    const clamped = clampRangeToChromosome(viewport.range, viewport.chrLength);
    return Math.max(1, Math.round(clamped.span / distribution.binSizeBp));
  }, [distribution, distributionContextIsValid, viewport.chrLength, viewport.range]);

  const contextLadder = useMemo(() => {
    if (!distribution || windowBins === null) {
      return null;
    }
    // Rank this region's average level against same-width windows across the
    // chromosome. Mean rather than peak because only a mean is comparable across
    // resolutions -- see buildWindowMeanLadder.
    return buildWindowMeanLadder(distribution.binValues, distribution.binWeights, windowBins);
  }, [distribution, windowBins]);

  const contextRank = useMemo(() => {
    if (!distributionContextIsValid || !distribution || !scaleInfo || !contextLadder) {
      return null;
    }
    const clamped = clampRangeToChromosome(viewport.range, viewport.chrLength);
    const mean = regionMean(distribution, clamped.start, clamped.end);
    if (!Number.isFinite(mean)) {
      return null;
    }
    const percentile = percentileOfValue(contextLadder, mean);
    if (!Number.isFinite(percentile)) {
      return null;
    }
    return { ladder: contextLadder, mean, percentile, label: formatPercentile(percentile) };
  }, [
    contextLadder,
    distribution,
    distributionContextIsValid,
    scaleInfo,
    viewport.chrLength,
    viewport.range,
  ]);

  const hoverXRef = useRef<number | null>(null);
  // Mutagenesis hover: the base under the pointer on an ISM row, and the
  // mutant predictions a prediction row draws for it.
  const hoverPositionRef = useRef<number | null>(null);
  const mutantFetchTimerRef = useRef<number | null>(null);
  const mutantOverlayRef = useRef<MutantOverlayDraw | null>(null);
  const [hoverEffect, setHoverEffect] = useState<string | null>(null);
  const reversedRef = useRef(reversed);
  const columnEditsRef = useRef(columnEdits);
  const hoverYRef = useRef<number | null>(null);
  // An annotation row grown past the height cap keeps a lane window; the wheel
  // over it moves the window. What the last draw needed lives here for the
  // note's click ("fit") and for clamping the window.
  const laneOffsetRef = useRef(0);
  const lanesReportRef = useRef<AnnotationLanesReport | null>(null);
  const viewportRef = useRef(viewport);
  const trackRef = useRef(track);
  const onHeightChangeRef = useRef(onHeightChange);
  const dataRef = useRef(data);
  const loadingRef = useRef(loading);
  const staleRef = useRef(stale);
  const errorRef = useRef(error);
  const signalDomainRef = useRef<SignalDomain | null>(effectiveSignalScale?.domain ?? null);
  const signalSeriesRef = useRef<readonly SignalSeriesMetadata[]>(signalSeries);
  const sequenceColumnsRef = useRef<readonly SequenceSignalColumn[]>(sequenceColumns);
  const sequenceRenderModeRef = useRef<SequenceSignalRenderMode>(sequenceRenderMode);
  const scaleShapeRef = useRef<SignalScaleShape>(scaleShape);
  const editedColumnLayoutRef = useRef<SequenceColumnLayout | null>(editedColumnLayout);
  const referenceSequenceRef = useRef<ReferenceSequenceWindow | null>(referenceSequence);
  const geneStrandCoverageRef = useRef<GeneStrandCoverage>(geneStrandCoverage);

  // Canvases can't inherit CSS variables, so they subscribe to the viewport theme
  // store directly and repaint when it flips. drawNow reads the palette at draw time.
  const dark = useSyncExternalStore(subscribeViewportTheme, isViewportDark, isViewportDark);

  const computationalHint = useMemo(() => {
    if (track.source.type !== 'computational') {
      return null;
    }

    // One fact, said once. The model's group header already carries the reason
    // this model is paused ("Zoom in to <= N bp window", "Requires hg38") for
    // ALL of its tracks together; repeating it as a boxed hint in every empty
    // row said the same thing N more times in a second phrasing. The rows stay
    // quiet; only a per-track resolution cap -- which the header cannot state
    // for one track -- is still named in the row it applies to.
    const eligibility = deriveComputationalEligibility(
      track.source.pack,
      viewport,
      windowSpec.resolutionBp,
      track.source.subtrack,
    );
    if (eligibility.reason === 'resolution') {
      return `Zoom in to <= ${eligibility.maxResolutionBp?.toLocaleString('en-US')} bp/bin`;
    }
    // A mutagenesis row is paid per base on screen, so it has its own width.
    if (eligibility.reason === 'mutagenesis-span') {
      return `Zoom in to <= ${eligibility.maxSpanBp?.toLocaleString('en-US')} bp for ISM`;
    }
    return null;
  }, [track.source, viewport, windowSpec.resolutionBp]);

  const drawNow = useCallback(() => {
    const canvas = canvasRef.current;
    const viewportSnapshot = viewportRef.current;
    const trackSnapshot = trackRef.current;
    const dataSnapshot = dataRef.current;
    const loadingSnapshot = loadingRef.current;
    const staleSnapshot = staleRef.current;
    const errorSnapshot = errorRef.current;
    const signalDomainSnapshot = signalDomainRef.current;
    const signalSeriesSnapshot = signalSeriesRef.current;
    const sequenceColumnsSnapshot = sequenceColumnsRef.current;
    const sequenceRenderModeSnapshot = sequenceRenderModeRef.current;
    const referenceSequenceSnapshot = referenceSequenceRef.current;
    const geneStrandCoverageSnapshot = geneStrandCoverageRef.current;

    if (!canvas || viewportSnapshot.widthPx <= 0) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const widthPx = Math.max(1, viewportSnapshot.widthPx);
    const heightPx = trackSnapshot.height;
    const pixelWidth = Math.round(widthPx * dpr);
    const pixelHeight = Math.round(heightPx * dpr);

    if (canvas.width !== pixelWidth) {
      canvas.width = pixelWidth;
    }
    if (canvas.height !== pixelHeight) {
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${heightPx}px`;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const palette = getViewportPalette();

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, widthPx, heightPx);

    context.fillStyle = palette.bg;
    context.fillRect(0, 0, widthPx, heightPx);

    // Where the sequence was edited, on every row, under the data. Drawn in
    // screen space (before the strand mirror) because the axis already oriented it.
    if (columnEditsRef.current && columnEditsRef.current.length > 0) {
      const boundedForBands = clampRangeToChromosome(viewportSnapshot.range, viewportSnapshot.chrLength);
      const axis = buildDisplayAxis({
        startBp: boundedForBands.start,
        endBp: boundedForBands.end,
        widthPx,
        reversed: reversedRef.current,
        edits: columnEditsRef.current,
      });
      drawEditBands(context, axis, 0, heightPx);
    }

    // Minus strand: mirror x once, here. Every renderer below keeps drawing in
    // genomic-increasing x and comes out reversed, which is what keeps them
    // strand-agnostic. Text is the one thing that must not mirror; see
    // `upright()` on the renderers that emit it.
    if (reversedRef.current) {
      context.translate(widthPx, 0);
      context.scale(-1, 1);
    }

    const boundedRange = clampRangeToChromosome(viewportSnapshot.range, viewportSnapshot.chrLength);

    // Whatever is on hand is drawn at full strength, and the readout at the top
    // right says what is still coming. Ghosting the canvas to 40% greyed the
    // WHOLE row while one edge of it recomputed, which read as the entire track
    // being out of date -- and since a mutagenesis run now publishes each batch
    // of bases as it finishes, most of what is drawn mid-run is this screen's
    // own answer, not the previous screen's.
    context.globalAlpha = 1;
    if (dataSnapshot?.features) {
      if (trackSnapshot.kind === 'signal') {
        if (signalDomainSnapshot) {
          if (sequenceRenderModeSnapshot !== 'signal' && sequenceColumnsSnapshot.length > 0) {
            drawSequenceSignal(
              context,
              sequenceColumnsSnapshot,
              sequenceRenderModeSnapshot,
              viewportSnapshot.chr,
              boundedRange.start,
              viewportSnapshot.bpPerPx,
              widthPx,
              heightPx,
              hoverXRef.current,
              palette,
              signalDomainSnapshot,
              scaleShapeRef.current,
              editedColumnLayoutRef.current,
            );
          } else {
            drawSignal(
              context,
              dataSnapshot.features,
              boundedRange.start,
              viewportSnapshot.bpPerPx,
              widthPx,
              heightPx,
              hoverXRef.current,
              palette,
              signalDomainSnapshot,
              signalSeriesSnapshot,
              scaleShapeRef.current,
              editedColumnLayoutRef.current,
              referenceSequenceSnapshot,
              geneStrandCoverageSnapshot,
              signalRenderStyle(trackSnapshot),
              mutantOverlayRef.current,
            );
          }
        }
      } else {
        lanesReportRef.current = drawAnnotation(
          context,
          dataSnapshot.features,
          boundedRange.start,
          viewportSnapshot.bpPerPx,
          widthPx,
          heightPx,
          trackSnapshot.color,
          hoverXRef.current,
          hoverYRef.current,
          palette,
          editedColumnLayoutRef.current,
          laneOffsetRef.current,
          onHeightChangeRef.current !== undefined,
        );
        if (lanesReportRef.current) {
          laneOffsetRef.current = lanesReportRef.current.laneOffset;
        }
        // Reported on the canvas for tests and tooling: lanes needed, drawn, hidden.
        const report = lanesReportRef.current;
        canvas.dataset.lanes = report ? `${report.laneCount}:${report.drawnLanes}:${report.hidden}` : '';
      }
    }

    context.globalAlpha = 1;
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    if (loadingSnapshot) {
      // Say what is being waited for. A mutagenesis row is three forward passes
      // per base on screen and takes seconds; "loading" undersold it. Over a
      // ghosted previous answer, say that too.
      const kind =
        trackSnapshot.source.type === 'computational'
          ? trackSnapshot.source.subtrack.mutagenesis
            ? 'computing ISM'
            : 'computing'
          : 'loading';
      const loadingLabel = staleSnapshot ? `${kind}… showing previous` : `${kind}…`;
      context.fillStyle = palette.inkSoft;
      upright(context, loadingLabel, widthPx - 10 - context.measureText(loadingLabel).width, 12);
    }

    if (errorSnapshot) {
      context.fillStyle = palette.error;
      upright(context, errorSnapshot, 10, heightPx - 10);
    }

    if (!errorSnapshot && !loadingSnapshot && computationalHint && (!dataSnapshot?.features || dataSnapshot.features.length === 0)) {
      drawTrackHint(context, widthPx, heightPx, computationalHint, palette);
    }
  }, [computationalHint]);

  const scheduleDraw = useCallback(() => {
    trackRedrawScheduler.request(drawNow);
  }, [drawNow]);

  useEffect(() => {
    const unregister = trackRedrawScheduler.register(drawNow);
    trackRedrawScheduler.request(drawNow);
    return unregister;
  }, [drawNow]);

  useEffect(() => {
    viewportRef.current = viewport;
    trackRef.current = track;
    onHeightChangeRef.current = onHeightChange;
    scheduleDraw();
  }, [onHeightChange, scheduleDraw, track, viewport]);

  useEffect(() => {
    dataRef.current = data;
    loadingRef.current = loading;
    staleRef.current = stale;
    errorRef.current = error;
    scheduleDraw();
  }, [data, error, loading, stale, scheduleDraw]);

  useEffect(() => {
    signalDomainRef.current = effectiveSignalScale?.domain ?? null;
    signalSeriesRef.current = signalSeries;
    sequenceColumnsRef.current = sequenceColumns;
    sequenceRenderModeRef.current = sequenceRenderMode;
    scaleShapeRef.current = scaleShape;
    reversedRef.current = reversed;
    columnEditsRef.current = columnEdits;
    editedColumnLayoutRef.current = editedColumnLayout;
    referenceSequenceRef.current = referenceSequence;
    geneStrandCoverageRef.current = geneStrandCoverage;
    scheduleDraw();
  }, [
    editedColumnLayout,
    effectiveSignalScale,
    geneStrandCoverage,
    referenceSequence,
    reversed,
    columnEdits,
    scaleShape,
    scheduleDraw,
    sequenceColumns,
    sequenceRenderMode,
    signalSeries,
  ]);

  useEffect(() => {
    scheduleDraw();
  }, [computationalHint, scheduleDraw]);

  // Repaint when the theme flips (drawNow reads the palette from paletteRef).
  useEffect(() => {
    scheduleDraw();
  }, [dark, scheduleDraw]);

  // An ISM row publishes the base under the pointer, with what the mean of its
  // three mutants predicts. Every prediction series of the same model instance
  // and strand draws its own channel of it: combined plots, split rows and
  // user-grouped rows alike, reference and edited sequence alike.
  const isMutagenesisRow =
    track.source.type === 'computational' &&
    Boolean(track.source.subtrack.mutagenesis) &&
    (track.source.seriesSubtrackIds?.length ?? 1) <= 1;
  const storeOverlay = useSyncExternalStore(subscribeMutantOverlay, getMutantOverlay, getMutantOverlay);
  const mutantOverlay = useMemo<MutantOverlayDraw | null>(() => {
    if (!storeOverlay || track.kind !== 'signal') {
      return null;
    }
    const channelFor = (
      source: Extract<TrackSpec['source'], { type: 'computational' }>,
      subtrack: ComputationalSubtrackSpec,
    ): number | null => {
      if (subtrack.mutagenesis || subtrack.outputName !== storeOverlay.outputName) {
        return null;
      }
      const instanceId = source.instanceId ?? `${source.pack.id}|${source.packUrl}`;
      if (instanceId !== storeOverlay.instanceId || storeOverlay.chr !== viewport.chr) {
        return null;
      }
      if (storeOverlay.strand !== (source.reverseComplement ? '-' : '+')) {
        return null;
      }
      const channel = subtrack.channelIndex ?? 0;
      return channel < storeOverlay.data.channelCount ? channel : null;
    };
    let channelBySeries: (number | null)[];
    if (track.source.type === 'group') {
      channelBySeries = track.source.members.map((member) =>
        member.source.type === 'computational' ? channelFor(member.source, member.source.subtrack) : null,
      );
    } else if (track.source.type === 'computational') {
      const source = track.source;
      channelBySeries = resolveComputationalTrackSubtracks(source).map((subtrack) => channelFor(source, subtrack));
    } else {
      return null;
    }
    if (channelBySeries.every((channel) => channel === null)) {
      return null;
    }
    return { overlay: storeOverlay, channelBySeries, indexOf: mutantOverlayIndex(storeOverlay.data) };
  }, [storeOverlay, track, viewport.chr]);
  useEffect(() => {
    mutantOverlayRef.current = mutantOverlay;
    scheduleDraw();
  }, [mutantOverlay, scheduleDraw]);
  useEffect(
    () => () => {
      if (mutantFetchTimerRef.current !== null) {
        window.clearTimeout(mutantFetchTimerRef.current);
      }
      clearMutantOverlay(track.id);
    },
    [track.id],
  );

  const publishMutagenesisHover = useCallback((hoverX: number, rowWidth: number) => {
    if (!isMutagenesisRow || sequenceRenderModeRef.current === 'signal') {
      return;
    }
    const viewportSnapshot = viewportRef.current;
    const bounded = clampRangeToChromosome(viewportSnapshot.range, viewportSnapshot.chrLength);
    const hoverBp = makeXToBp(editedColumnLayoutRef.current, bounded.start, viewportSnapshot.bpPerPx, rowWidth)(hoverX);
    const column = sequenceColumnsRef.current.find(
      (candidate) => hoverBp >= candidate.feature.start && hoverBp < candidate.feature.end,
    );
    const position = column ? column.position : null;
    if (position === hoverPositionRef.current) {
      return;
    }
    hoverPositionRef.current = position;
    const effect = column?.feature.mutantEffect;
    setHoverEffect(effect ? describeMutantEffect(effect) : null);
    if (mutantFetchTimerRef.current !== null) {
      window.clearTimeout(mutantFetchTimerRef.current);
      mutantFetchTimerRef.current = null;
    }
    const source = trackRef.current.source;
    if (position === null || source.type !== 'computational') {
      clearMutantOverlay(trackRef.current.id);
      return;
    }
    const ownerTrackId = trackRef.current.id;
    const chr = viewportSnapshot.chr;
    // A short settle so a pointer sweeping across the row asks for one base, not sixty.
    mutantFetchTimerRef.current = window.setTimeout(() => {
      mutantFetchTimerRef.current = null;
      void fetchMutantPredictions(source, chr, position).then((data) => {
        if (hoverPositionRef.current !== position) {
          return;
        }
        if (!data) {
          clearMutantOverlay(ownerTrackId);
          return;
        }
        setMutantOverlay({
          ownerTrackId,
          instanceId: source.instanceId ?? `${source.pack.id}|${source.packUrl}`,
          chr,
          strand: source.reverseComplement ? '-' : '+',
          outputName: source.subtrack.outputName,
          data,
        });
      });
    }, 40);
  }, [isMutagenesisRow]);

  // The row changed under a resting pointer -- its ISM run landed, or an edit
  // re-scored it: say what is under the pointer now, rather than waiting for it
  // to move. Hover used to update only on movement, so a pointer rested on a
  // row that was still computing never showed anything.
  useEffect(() => {
    if (!isMutagenesisRow || hoverXRef.current === null) {
      return;
    }
    hoverPositionRef.current = null;
    publishMutagenesisHover(hoverXRef.current, viewportRef.current.widthPx);
  }, [data, sequenceColumns, sequenceRenderMode, isMutagenesisRow, publishMutagenesisHover]);

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    // Renderers receive hover x in their own (mirrored-on-minus) space, so the
    // guide and the hit-test line up with the base under the pointer either way.
    const localX = event.clientX - rect.left;
    hoverXRef.current = reversedRef.current ? rect.width - localX : localX;
    hoverYRef.current = event.clientY - rect.top;
    publishMutagenesisHover(hoverXRef.current, rect.width);
    scheduleDraw();
  };

  const resizable = track.kind === 'annotation' && onHeightChange !== undefined;

  /**
   * The hidden-count note, clicked: grow the row to fit its lanes.
   *
   * Not a click handler, and not a pointer-up on the canvas either: the viewport
   * captures every pointer-down for its drag, so the release is delivered to the
   * capturing element and the canvas never hears it, nor a click. The down is
   * noted here; the release is heard on the window, in the capture phase, where
   * no capture can hide it. A press that moved is a pan, not a click.
   */
  const notePressRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const report = lanesReportRef.current;
    if (!resizable || event.button !== 0 || !report || report.hidden === 0) {
      notePressRef.current = null;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    // The note sits in the top-right corner of the SCREEN, mirrored or not.
    const inNote = event.clientX - rect.left > rect.width - 220 && event.clientY - rect.top < 18;
    notePressRef.current = inNote ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId } : null;
  };
  useEffect(() => {
    if (!resizable) {
      return;
    }
    const onWindowPointerUp = (event: PointerEvent) => {
      const press = notePressRef.current;
      if (!press || event.pointerId !== press.pointerId) {
        return;
      }
      notePressRef.current = null;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
        return;
      }
      const report = lanesReportRef.current;
      const current = trackRef.current;
      if (!report || report.hidden === 0) {
        return;
      }
      const target = annotationHeightForLanes(report.laneCount, report.geneHeaderPx, window.innerHeight);
      if (target > current.height) {
        laneOffsetRef.current = 0;
        onHeightChangeRef.current?.(current, target);
      }
    };
    window.addEventListener('pointerup', onWindowPointerUp, true);
    return () => window.removeEventListener('pointerup', onWindowPointerUp, true);
  }, [resizable]);

  // A row at its cap scrolls its lanes instead of growing. Attached natively
  // because the viewport's own wheel handler (a pan/zoom/list-scroll router)
  // is native too, and a React handler would run after it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !resizable) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      const report = lanesReportRef.current;
      if (!report || report.laneCount <= report.drawnLanes || event.ctrlKey || event.metaKey) {
        return;
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      const step = event.deltaMode === 0 ? Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 24)) : Math.sign(event.deltaY);
      const next = clampLaneOffset(laneOffsetRef.current + step, report.laneCount, report.drawnLanes);
      if (next === laneOffsetRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      laneOffsetRef.current = next;
      scheduleDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [resizable, scheduleDraw]);

  /** The lower edge, dragged. Pointer capture keeps the drag past the row. */
  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = track.height;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer; the drag still works without capture.
    }
    const onMove = (move: PointerEvent) => {
      const next = clampTrackHeightPx(startHeight + (move.clientY - startY), window.innerHeight);
      onHeightChange?.(track, next);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const handlePointerLeave = () => {
    if (hoverXRef.current !== null || hoverYRef.current !== null) {
      hoverXRef.current = null;
      hoverYRef.current = null;
      scheduleDraw();
    }
    if (isMutagenesisRow) {
      hoverPositionRef.current = null;
      if (mutantFetchTimerRef.current !== null) {
        window.clearTimeout(mutantFetchTimerRef.current);
        mutantFetchTimerRef.current = null;
      }
      setHoverEffect(null);
      clearMutantOverlay(track.id);
    }
  };

  const isModel = track.source.type === 'computational';
  const sourceLabel =
    track.source.type === 'computational'
      ? track.source.subtrack.role ??
        (track.source.subtrack.id.includes('effect') ? 'effect' : 'prediction')
      : track.source.type === 'group'
        ? 'combined'
        : track.source.type === 'bigwig'
          ? 'bigwig'
          : track.source.type === 'bigbed'
            ? 'bigbed'
            : track.kind;
  const groupingAction = onPlotGroupingChange ? plotGroupingAction(track) : null;
  // A combined row wears every member's colour, stacked.
  const chipBackground = signalSeries.length > 1
    ? stackedSwatch(signalSeries.map((series) => series.color))
    : track.color;
  const outputIds = isModel ? signalSeries.map((series) => series.id) : [];
  const configuredScaleMode = track.kind === 'signal'
    ? track.yScale?.mode ?? 'auto'
    : undefined;
  const seriesDescription = signalSeries
    .map((series) => `${series.name}${series.lineStyle === 'dashed' ? ' (dashed)' : ''}`)
    .join(', ');
  const scaleTitle = scaleInfo
    ? `${scaleInfo.mode.toUpperCase()} scale · ${scaleInfo.bottomLabel} to ${scaleInfo.topLabel}` +
      (scaleInfo.mode === 'auto'
        ? ' for the visible range.'
        : scaleInfo.mode === 'linked'
          ? ' shared by the mounted tracks in this comparison group.'
          : ' using user-specified limits.') +
      (contextRank && distribution
        ? ` This region averages ${formatScaleValue(contextRank.mean)}, ranking ${contextRank.label} ` +
          `among same-width windows on ${viewport.chr} ` +
          `(${Math.round(distribution.coveredBases / 1e6).toLocaleString('en-US')} Mb of covered bases).`
        : scaleInfo.kind === 'density'
          ? ' Annotation density is locally autoscaled.'
          : '')
    : undefined;

  return (
    <div
      className="track-row"
      data-selected={selected ? 'true' : undefined}
      style={{
        height: `${track.height}px`,
        ...(grouping
          ? ({
              '--group-color': grouping.groupColor,
              '--subgroup-color': grouping.subgroupColor ?? grouping.groupColor,
            } as CSSProperties)
          : {}),
      }}
      data-inspectable={onSelect ? 'true' : undefined}
      data-model={isModel ? 'true' : undefined}
      data-group-depth={grouping?.depth}
      data-subgroup-id={grouping?.subgroupId}
      data-section={grouping?.section}
      data-partial={partial ? 'true' : undefined}
      data-hover-effect={hoverEffect ?? undefined}
      data-mutant-overlay={mutantOverlay ? mutantOverlay.overlay.data.position : undefined}
      data-mutant-overlay-channels={
        mutantOverlay ? mutantOverlay.channelBySeries.filter((channel) => channel !== null).join(' ') : undefined
      }
      data-model-id={track.source.type === 'computational' ? track.source.pack.id : undefined}
      data-model-instance-id={track.source.type === 'computational' ? track.source.instanceId : undefined}
      data-output-id={track.source.type === 'computational' ? track.source.subtrack.id : undefined}
      data-output-group={track.source.type === 'computational' ? track.source.subtrack.groupId : undefined}
      data-output-ids={outputIds.length > 0 ? outputIds.join(' ') : undefined}
      data-series-count={track.kind === 'signal' ? signalSeries.length : undefined}
      data-scale-shape={track.kind === 'signal' ? scaleShape : undefined}
      data-scale-mode={configuredScaleMode}
      data-scale-min={track.kind === 'signal' ? effectiveSignalScale?.domain.min : undefined}
      data-scale-max={track.kind === 'signal' ? effectiveSignalScale?.domain.max : undefined}
      data-data-resolution={track.kind === 'signal' ? data?.spec.resolutionBp : undefined}
      data-signal-display={track.kind === 'signal' ? requestedSignalDisplay : undefined}
      data-compact={track.height <= 40 ? 'true' : undefined}
      data-resizable={resizable ? 'true' : undefined}
      data-height={track.height}
      data-sequence-render-mode={sequenceDisplayRequested ? sequenceRenderMode : undefined}
    >
      <div className="track-label">
        {/* Chip ties the label column to the waveform's color in the canvas. */}
        <span className="track-chip" style={{ background: chipBackground }} aria-hidden="true" />
        {onSelect ? <button type="button" className="track-name wb-plot-select" aria-label={`Inspect ${track.name}`} aria-pressed={selected ?? false} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onClick={() => onSelect(track)}>{track.name}</button> : <span className="track-name">{track.name}</span>}
        <span className="track-tags">
          {(!onSelect || !isModel) && <span className={`track-tag${isModel ? ' model' : ''}`}>{sourceLabel === 'bigwig' ? 'BigWig' : sourceLabel === 'bigbed' ? 'BigBed' : sourceLabel}</span>}
          {!onSelect && <span className="track-kind">{track.kind}</span>}
          {!onSelect && track.kind === 'signal' && signalSeries.length === 1 && onSignalDisplayChange ? (
            <button
              className={`track-sequence-display-toggle${requestedSignalDisplay === 'sequence' ? ' active' : ''}`}
              type="button"
              aria-pressed={requestedSignalDisplay === 'sequence'}
              aria-label={`${requestedSignalDisplay === 'sequence' ? 'Use signal plot for' : 'Use DNA height for'} ${track.name}`}
              title={
                requestedSignalDisplay === 'sequence'
                  ? 'DNA height is active at true base-pair resolution; zoomed-out data remains a signal.'
                  : 'Scale each true 1-bp A/C/G/T value above or below zero.'
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSignalDisplayChange(
                  track,
                  requestedSignalDisplay === 'sequence' ? 'signal' : 'sequence',
                );
              }}
            >
              DNA
            </button>
          ) : null}
          {track.kind === 'signal' && onSignalScaleShapeChange ? (
            <button
              className={`track-scale-shape-toggle${scaleShape !== 'linear' ? ' active' : ''}`}
              type="button"
              aria-label={`Scale shape for ${track.name}: ${scaleShape}. Click for ${nextScaleShape}.`}
              data-scale-shape={scaleShape}
              title={signalScaleShapeTitle(scaleShape, nextScaleShape)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSignalScaleShapeChange(track, nextScaleShape);
              }}
            >
              {signalScaleShapeLabel(scaleShape)}
            </button>
          ) : null}
          {groupingAction && onPlotGroupingChange ? (
            <button
              className="track-grouping-toggle"
              type="button"
              aria-label={`${groupingAction.title} (${track.name})`}
              title={groupingAction.title}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onPlotGroupingChange(track, groupingAction.kind);
              }}
            >
              {onSelect ? groupingAction.label[0] + groupingAction.label.slice(1).toLowerCase() : groupingAction.label}
            </button>
          ) : null}
          {onHideOnEdited && track.source.type === 'computational' && track.source.editRole === 'edited' ? (
            <button
              className="track-grouping-toggle track-hide-on-edited"
              type="button"
              aria-label={`Hide ${track.name} on the edited sequence`}
              title="Stop re-running this output on the edited sequence. The section header offers it back."
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onHideOnEdited(track);
              }}
            >
              HIDE
            </button>
          ) : null}
          {onSelect && requestedSignalDisplay === 'sequence' && <span className="wb-plot-state">DNA height</span>}
          {onSelect && !onSignalScaleShapeChange && scaleShape !== 'linear' && <span className="wb-plot-state" title={signalScaleShapeTitle(scaleShape, nextScaleShape)}>{scaleShape === 'power' ? 'Power' : signalScaleShapeLabel(scaleShape)}</span>}
          {signalSeries.length > 1 ? (
            <span
              className="track-series-legend"
              role="list"
              aria-label={`Series: ${seriesDescription}`}
              title={seriesDescription}
            >
              {signalSeries.map((series, index) => (
                <span
                  key={series.id}
                  className={`track-series-item ${series.lineStyle}`}
                  role="listitem"
                  data-series-id={series.id}
                  data-series-style={series.lineStyle}
                  hidden={index >= 3}
                  title={`${series.name} · ${series.lineStyle}`}
                >
                  <span
                    className="track-series-swatch"
                    style={{ color: series.color }}
                    aria-hidden="true"
                  >
                    {series.lineStyle === 'dashed' ? '┄' : '●'}
                  </span>
                  <span className="track-series-name" style={{ color: series.color }}>{series.name}</span>
                </span>
              ))}
              {signalSeries.length > 3 ? (
                <span className="track-series-more" aria-hidden="true">
                  +{signalSeries.length - 3}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {scaleInfo ? (
          <span
            className="track-scale"
            title={scaleTitle}
          >
            {distribution && contextRank ? (
              <SignalContextStrip
                ladder={contextRank.ladder}
                viewMax={contextRank.mean}
                heightPx={track.height - 20}
              />
            ) : null}
            <span className="track-scale-labels">
              <span>{scaleInfo.topLabel}</span>
              <span className="track-scale-mode">{onSelect ? scaleInfo.mode : scaleInfo.mode.toUpperCase()}</span>
              {contextRank ? <span className="track-scale-rank">{contextRank.label}</span> : null}
              <span>{scaleInfo.bottomLabel}</span>
            </span>
          </span>
        ) : null}
      </div>
      <canvas
        className="track-canvas"
        ref={canvasRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handleCanvasPointerDown}
      />
      {resizable ? (
        <div
          className="track-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${track.name}`}
          aria-valuenow={track.height}
          aria-valuemin={40}
          aria-valuemax={maxTrackHeightPx(typeof window === 'undefined' ? 0 : window.innerHeight)}
          title="Drag to change the row height"
          onPointerDown={handleResizeStart}
        />
      ) : null}
    </div>
  );
});
