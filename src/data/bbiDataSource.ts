import { serializeSequenceEdits } from '../features/sequence/edits';
import { clamp } from '../lib/genomeMath';
import type { Chromosome, DataWindowSpec, FeatureStrand, TrackFeature, TrackSource, TrackSpec } from '../types';
import type { SignalDistribution } from '../lib/signalDistribution';
import { getReader, readBigBedRows, resolveSourceUrl } from './bbiReader';
import { geneSymbolFromBigGenePred } from '../lib/bigGenePred';
import { fetchComputationalTrackWindow } from './computationalDataSource';
import { fetchMockTrackWindow } from './mockDataSource';
import { fetchManeTranscriptIds } from './maneIndex';

const chromosomeCache = new Map<string, Promise<Chromosome[]>>();
const bigWigReductionLevelsCache = new Map<string, number[]>();

const CANONICAL_CHR_PATTERN = /^chr(?:[1-9]|1\d|2[0-2]|X|Y|M|MT)$/i;
const MAX_BIGBED_FEATURES = 18_000;
const DEFAULT_BIGBED_VISIBILITY_WINDOW_BP = 9_000_000;

function sourceSignature(source: TrackSource): string {
  switch (source.type) {
    case 'bigwig':
      return `bigwig:${source.url}`;
    case 'bigbed':
      return `bigbed:${source.url}`;
    case 'computational': {
      const seriesSignature = source.seriesSubtrackIds?.length
        ? `:series${encodeURIComponent(JSON.stringify(source.seriesSubtrackIds))}`
        : '';
      const editsSignature = serializeSequenceEdits(source.sequenceEdits);
      const roleSignature = source.editRole === 'edited' ? ':edited' : '';
      const variantSignature = source.sequenceVariantId ? `:var${source.sequenceVariantId}` : '';
      const strandSignature = source.reverseComplement ? ':minus' : '';
      return `computational:${source.pack.id}:${source.subtrack.id}${seriesSignature}${roleSignature}${variantSignature}${strandSignature}:edits${editsSignature}:${source.packUrl}`;
    }
    case 'sequence-variant':
      return `sequence-variant:${source.variantId}:${serializeSequenceEdits(source.edits)}`;
    case 'group':
      return `group:[${source.members.map((member) => sourceSignature(member.source)).join('+')}]`;
    default:
      return 'mock';
  }
}

function parseStrand(value: string | undefined): FeatureStrand {
  if (value === '+' || value === '-') {
    return value;
  }
  return '.';
}

export type BigBedRowLike = {
  start: number;
  end: number;
  name?: string;
  score?: number;
  strand?: string;
  cdStart?: number;
  cdEnd?: number;
  exons?: Array<{ start: number; end: number }>;
  /** Columns past BED12, e.g. a bigGenePred's name2 … geneType. */
  extra?: string[];
};

/** Map a bigBed / bigGenePred row into a TrackFeature, preserving exon and CDS geometry. */
export function mapBigBedRowToTrackFeature(feature: BigBedRowLike): TrackFeature {
  const rawScore = Number(feature.score);
  const score = Number.isFinite(rawScore) ? clamp(rawScore / 1000, 0, 1) : 0.5;
  const exons = Array.isArray(feature.exons)
    ? feature.exons
        .filter((exon) => Number.isFinite(exon.start) && Number.isFinite(exon.end) && exon.end > exon.start)
        .map((exon) => ({ start: exon.start, end: exon.end }))
    : undefined;
  const cdsStart = Number(feature.cdStart);
  const cdsEnd = Number(feature.cdEnd);
  const hasCds = Number.isFinite(cdsStart) && Number.isFinite(cdsEnd) && cdsEnd > cdsStart;
  // The label a person reads is the gene; the transcript id rides along.
  const name = feature.name && feature.name !== '.' ? feature.name : undefined;
  const symbol = geneSymbolFromBigGenePred(name, feature.extra);

  return {
    start: feature.start,
    end: feature.end,
    score,
    label: symbol ?? name,
    ...(symbol && name ? { transcriptId: name } : {}),
    strand: parseStrand(feature.strand),
    renderMode: 'interval',
    ...(exons && exons.length > 0 ? { exons } : {}),
    ...(hasCds ? { cdsStart, cdsEnd } : {}),
  };
}

function resolveReferenceName(chromToId: Record<string, number>, requestedChr: string): string | null {
  if (requestedChr in chromToId) {
    return requestedChr;
  }

  const withChr = requestedChr.startsWith('chr') ? requestedChr : `chr${requestedChr}`;
  if (withChr in chromToId) {
    return withChr;
  }

  const withoutChr = requestedChr.startsWith('chr') ? requestedChr.slice(3) : requestedChr;
  if (withoutChr in chromToId) {
    return withoutChr;
  }

  return null;
}

function normalizeChromosomes(chromosomes: Chromosome[]): Chromosome[] {
  if (chromosomes.length === 0) {
    return chromosomes;
  }

  const canonical = chromosomes.filter((item) => CANONICAL_CHR_PATTERN.test(item.id));
  const candidate = canonical.length > 0 ? canonical : chromosomes;

  return candidate.sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

async function loadChromosomesFromSource(source: TrackSource): Promise<Chromosome[]> {
  if (source.type !== 'bigwig' && source.type !== 'bigbed') {
    return [];
  }

  const signature = sourceSignature(source);
  const cached = chromosomeCache.get(signature);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const reader = getReader(source.url);
    const header = await reader.getHeader();
    const chromSize = header.chromTree?.chromSize ?? {};
    const chromosomes = Object.entries(chromSize).map(([id, length]) => ({ id, length }));
    return normalizeChromosomes(chromosomes);
  })();

  chromosomeCache.set(signature, request);
  return request;
}

function pickZoomLevelIndex(
  reductionLevels: number[],
  targetBpPerPx: number,
): number | null {
  if (reductionLevels.length === 0) {
    return null;
  }

  // Prefer the coarsest reduction level that is still <= current bp/px target.
  // Note: files may store zoom levels in either ascending or descending order.
  const threshold = targetBpPerPx * 2;
  let bestIndex: number | null = null;
  let bestReduction = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < reductionLevels.length; index += 1) {
    const reduction = reductionLevels[index];
    if (reduction <= threshold && reduction > bestReduction) {
      bestReduction = reduction;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function pickFinestZoomLevelIndex(reductionLevels: number[]): number | null {
  if (reductionLevels.length === 0) {
    return null;
  }

  let bestIndex = 0;
  let bestReduction = reductionLevels[0];
  for (let index = 1; index < reductionLevels.length; index += 1) {
    const reduction = reductionLevels[index];
    if (reduction < bestReduction) {
      bestReduction = reduction;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function mapZoomDensityRows(
  zoomData: Array<{
    start: number;
    end: number;
    validCount: number;
    sumData: number;
  }>,
): TrackFeature[] {
  return zoomData.map((item) => {
    const score = Math.max(
      0,
      Number.isFinite(item.validCount) ? item.validCount : 0,
      Number.isFinite(item.sumData) ? item.sumData : 0,
    );

    return {
      start: item.start,
      end: item.end,
      score,
      renderMode: 'density',
    };
  });
}

function aggregateBedRowsToDensity(
  rows: Array<{ start: number; end: number }>,
  startBp: number,
  endBp: number,
  resolutionBp: number,
): TrackFeature[] {
  const span = Math.max(1, endBp - startBp);
  const binSize = Math.max(1, resolutionBp);
  const binCount = Math.max(1, Math.ceil(span / binSize));
  const diff = new Float64Array(binCount + 1);

  for (const row of rows) {
    const startBin = clamp(Math.floor((row.start - startBp) / binSize), 0, binCount - 1);
    const endBinExclusive = clamp(Math.ceil((row.end - startBp) / binSize), 1, binCount);
    const boundedEnd = endBinExclusive <= startBin ? Math.min(binCount, startBin + 1) : endBinExclusive;
    diff[startBin] += 1;
    diff[boundedEnd] -= 1;
  }

  const features: TrackFeature[] = [];
  let value = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    value += diff[bin];
    if (value <= 0) {
      continue;
    }

    const binStart = startBp + bin * binSize;
    const binEnd = Math.min(endBp, binStart + binSize);
    features.push({
      start: binStart,
      end: Math.max(binStart + 1, binEnd),
      score: value,
      renderMode: 'density',
    });
  }

  return features;
}

export async function loadChromosomeCatalog(tracks: TrackSpec[]): Promise<Chromosome[]> {
  const preferredTrack =
    tracks.find((track) => track.source.type === 'bigwig') ??
    tracks.find((track) => track.source.type === 'bigbed');

  if (!preferredTrack) {
    return [];
  }

  return loadChromosomesFromSource(preferredTrack.source);
}

export function getTrackResolutionTag(track: TrackSpec, targetBpPerPx: number): string | null {
  if (track.source.type === 'bigwig') {
    const resolvedUrl = resolveSourceUrl(track.source.url);
    const reductionLevels = bigWigReductionLevelsCache.get(resolvedUrl);
    if (!reductionLevels || reductionLevels.length === 0) {
      return null;
    }

    const zoomLevelIndex = pickZoomLevelIndex(reductionLevels, targetBpPerPx);
    if (zoomLevelIndex === null) {
      return 'raw';
    }

    return `z${reductionLevels[zoomLevelIndex]}`;
  }

  return null;
}

async function fetchBigWigWindow(
  source: Extract<TrackSource, { type: 'bigwig' }>,
  chr: string,
  spec: DataWindowSpec,
): Promise<TrackFeature[]> {
  const reader = getReader(source.url);
  const header = await reader.getHeader();
  const chromToId = header.chromTree?.chromToId ?? {};
  const refName = resolveReferenceName(chromToId, chr);
  if (!refName) {
    return [];
  }

  const reductionLevels = (header.zoomLevelHeaders ?? []).map((item) => item.reductionLevel);
  const resolvedUrl = resolveSourceUrl(source.url);
  if (!bigWigReductionLevelsCache.has(resolvedUrl)) {
    bigWigReductionLevelsCache.set(resolvedUrl, reductionLevels);
  }
  const zoomLevelIndex = pickZoomLevelIndex(reductionLevels, spec.resolutionBp);
  const features: TrackFeature[] = [];

  if (zoomLevelIndex !== null && spec.resolutionBp >= 40) {
    const zoomData = await reader.readZoomData(
      refName,
      spec.requestStart,
      refName,
      spec.requestEnd,
      zoomLevelIndex,
    );

    for (const item of zoomData) {
      const mean = item.validCount > 0 ? item.sumData / item.validCount : 0;
      features.push({
        start: item.start,
        end: item.end,
        score: Number.isFinite(mean) ? mean : 0,
      });
    }

    return features;
  }

  const wigData = await reader.readBigWigData(refName, spec.requestStart, refName, spec.requestEnd);
  for (const item of wigData) {
    features.push({
      start: item.start,
      end: item.end,
      score: Number.isFinite(item.value) ? item.value : 0,
    });
  }

  return features;
}

// A chromosome-wide summary read is ~1MB and a few ms to parse, so it is cached per
// (file, chromosome, zoom level) and never repeated. Keyed on the resolved reduction
// level rather than the requested resolution so nearby zooms share one fetch.
const signalDistributionCache = new Map<string, Promise<SignalDistribution | null>>();

// Cap on summary records pulled for one distribution. chr1 at 12kb bins is ~20k
// records (~1MB); finer levels explode (752bp bins would be ~331k records / 4.5MB)
// without meaningfully changing the answer to "is this region high or low".
const MAX_DISTRIBUTION_RECORDS = 60_000;

/**
 * Build the value distribution for a bigWig track across a whole chromosome.
 *
 * Uses the same `pickZoomLevelIndex` the renderer uses, so the distribution is binned
 * the same way as the values on screen and the two are directly comparable. If that
 * level would be too expensive chromosome-wide, steps to coarser levels and reports
 * the bin size it actually used so the UI can say so.
 */
export async function fetchSignalDistribution(
  source: Extract<TrackSource, { type: 'bigwig' }>,
  chr: string,
  resolutionBp: number,
): Promise<SignalDistribution | null> {
  const reader = getReader(source.url);
  const header = await reader.getHeader();
  const chromToId = header.chromTree?.chromToId;
  const chromSize = header.chromTree?.chromSize;
  if (!chromToId || !chromSize) {
    return null;
  }

  const refName = resolveReferenceName(chromToId, chr);
  if (!refName) {
    return null;
  }
  const chrLength = chromSize[refName];
  if (!chrLength) {
    return null;
  }

  const zoomHeaders = header.zoomLevelHeaders ?? [];
  if (zoomHeaders.length === 0) {
    return null;
  }
  const reductionLevels = zoomHeaders.map((item) => item.reductionLevel);

  // Start from what the renderer is showing, then coarsen until affordable.
  const rendered = pickZoomLevelIndex(reductionLevels, resolutionBp);
  const ordered = zoomHeaders
    .map((item, index) => ({ index, reduction: item.reductionLevel }))
    .sort((left, right) => left.reduction - right.reduction);
  const startAt = rendered === null ? 0 : ordered.findIndex((item) => item.index === rendered);
  const chosen =
    ordered.slice(Math.max(0, startAt)).find((item) => chrLength / item.reduction <= MAX_DISTRIBUTION_RECORDS) ??
    ordered[ordered.length - 1];

  const cacheKey = `${resolveSourceUrl(source.url)}|${refName}|${chosen.reduction}`;
  const cached = signalDistributionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = (async (): Promise<SignalDistribution | null> => {
    const records = await reader.readZoomData(refName, 0, refName, chrLength, chosen.index);
    if (records.length === 0) {
      return null;
    }

    const binValues: number[] = [];
    const binWeights: number[] = [];
    const binStarts: number[] = [];
    const binEnds: number[] = [];
    let coveredBases = 0;
    let sumData = 0;
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;

    for (const record of records) {
      const weight = record.validCount;
      if (!Number.isFinite(weight) || weight <= 0) {
        continue;
      }
      // sumData is a per-base sum, so this is the exact mean over the bin's bases.
      const mean = record.sumData / weight;
      if (!Number.isFinite(mean)) {
        continue;
      }
      binValues.push(mean);
      binWeights.push(weight);
      binStarts.push(record.start);
      binEnds.push(record.end);
      coveredBases += weight;
      sumData += record.sumData;
      minValue = Math.min(minValue, record.minVal);
      maxValue = Math.max(maxValue, record.maxVal);
    }

    if (binValues.length === 0 || coveredBases <= 0) {
      return null;
    }

    return {
      binValues: Float32Array.from(binValues),
      binWeights: Float32Array.from(binWeights),
      binStarts: Int32Array.from(binStarts),
      binEnds: Int32Array.from(binEnds),
      binSizeBp: chosen.reduction,
      coveredBases,
      minValue: Number.isFinite(minValue) ? minValue : 0,
      maxValue: Number.isFinite(maxValue) ? maxValue : 0,
      meanValue: sumData / coveredBases,
    };
  })().catch(() => null);

  signalDistributionCache.set(cacheKey, request);
  return request;
}

async function fetchBigBedWindow(
  source: Extract<TrackSource, { type: 'bigbed' }>,
  chr: string,
  spec: DataWindowSpec,
): Promise<TrackFeature[]> {
  const reader = getReader(source.url);
  const header = await reader.getHeader();
  const chromToId = header.chromTree?.chromToId ?? {};
  const refName = resolveReferenceName(chromToId, chr);
  if (!refName) {
    return [];
  }

  const span = spec.requestEnd - spec.requestStart;
  const visibilityWindow = source.visibilityWindowBp ?? DEFAULT_BIGBED_VISIBILITY_WINDOW_BP;
  const reductionLevels = (header.zoomLevelHeaders ?? []).map((item) => item.reductionLevel);

  if (span > visibilityWindow) {
    const preferredZoomLevel = pickZoomLevelIndex(reductionLevels, spec.resolutionBp);
    const finestZoomLevel = pickFinestZoomLevelIndex(reductionLevels);
    const candidateLevels = [preferredZoomLevel, finestZoomLevel].filter(
      (value, index, array): value is number => value !== null && array.indexOf(value) === index,
    );

    for (const zoomLevelIndex of candidateLevels) {
      const zoomData = await reader.readZoomData(
        refName,
        spec.requestStart,
        refName,
        spec.requestEnd,
        zoomLevelIndex,
      );
      if (zoomData.length > 0) {
        return mapZoomDensityRows(zoomData);
      }
    }

    // Transition safety: if zoom summaries are unavailable/empty for this span,
    // pull raw rows and aggregate to density so annotation never disappears.
    if (span <= visibilityWindow * 2) {
      const rawRows = await readBigBedRows(reader, refName, spec.requestStart, spec.requestEnd);
      if (rawRows.length > 0) {
        return aggregateBedRowsToDensity(rawRows, spec.requestStart, spec.requestEnd, spec.resolutionBp);
      }
    }

    return [];
  }

  const rawFeatures = await readBigBedRows(reader, refName, spec.requestStart, spec.requestEnd);
  if (rawFeatures.length === 0) {
    return [];
  }

  const overflow = rawFeatures.length > MAX_BIGBED_FEATURES;
  const sliceSize = overflow ? MAX_BIGBED_FEATURES : rawFeatures.length;
  const trimmed = rawFeatures.slice(0, sliceSize);
  const features = trimmed.map((feature) => mapBigBedRowToTrackFeature(feature));

  if (!source.maneUrl) {
    return features;
  }

  // Mark the representative transcript of each gene. A companion-track failure
  // leaves the set empty, which simply means nothing is singled out.
  const maneIds = await fetchManeTranscriptIds({
    url: source.maneUrl,
    chr: refName,
    start: spec.requestStart,
    end: spec.requestEnd,
  });
  if (maneIds.size === 0) {
    return features;
  }

  for (const feature of features) {
    const transcript = feature.transcriptId ?? feature.label;
    feature.emphasis = transcript && maneIds.has(transcript) ? 'primary' : 'secondary';
  }
  return features;
}

export function trackSourceKey(track: TrackSpec): string {
  return sourceSignature(track.source);
}

export async function fetchTrackWindow(
  track: TrackSpec,
  chr: string,
  spec: DataWindowSpec,
  signal?: AbortSignal,
  /** Only a computational window reports progress; the rest arrive whole. */
  onPartial?: (features: TrackFeature[]) => void,
): Promise<TrackFeature[]> {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  const { source } = track;
  if (source.type === 'bigwig') {
    return fetchBigWigWindow(source, chr, spec);
  }

  if (source.type === 'bigbed') {
    return fetchBigBedWindow(source, chr, spec);
  }

  if (source.type === 'computational') {
    return fetchComputationalTrackWindow(source, chr, spec, signal, onPartial);
  }

  if (source.type === 'sequence-variant') {
    return [];
  }

  if (source.type === 'group') {
    // Each member fetched as itself; the series index says which one a feature
    // belongs to. (The loader normally fans out through its own cache instead.)
    const perMember = await Promise.all(
      source.members.map((member) => fetchTrackWindow(member, chr, spec, signal)),
    );
    return perMember.flatMap((features, seriesIndex) => features.map((feature) => ({ ...feature, seriesIndex })));
  }

  return fetchMockTrackWindow({
    trackId: track.id,
    kind: track.kind,
    chr,
    start: spec.requestStart,
    end: spec.requestEnd,
    resolutionBp: spec.resolutionBp,
    signal,
  });
}
