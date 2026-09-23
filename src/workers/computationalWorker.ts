import { clamp } from '../lib/genomeMath';
import { seriesToBinnedFeatures } from '../lib/seriesBinning';
import {
  HARD_COMPUTATIONAL_MAX_SEQUENCE_BP,
  effectiveComputationalMaxWindowBp,
  recordInferenceCalibration,
} from '../lib/computationalLimits';
import { deriveCoveredExtent } from '../lib/inferenceExtent';
import {
  computationalOutputSetCovers,
  computationalSeriesKey,
  resolveComputationalOutputSetForSubtracks,
  resolveComputationalWarmupOutputSet,
  type ComputationalOutputSet,
} from '../lib/computationalOutputSet';
import { resolveComputationalTrackSubtracks } from '../lib/computationalPlotGroups';
import {
  applyEditsToSequence,
  extractInsertedScores,
  remapEditedScoresToGenomic,
  serializeSequenceEdits,
  type InsertedBaseScore,
} from '../features/sequence/edits';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, DataWindowSpec, SequenceEdit, TrackFeature } from '../types';
import type {
  ComputationalWorkerComputeRequest,
  ComputationalWorkerMutantsRequest,
  ComputationalWorkerRequest,
  ComputationalWorkerResponse,
  ComputationalWorkerWarmupRequest,
} from '../data/computationalWorkerProtocol';
import { encodeDnaOneHotNcl, fetchGenomeSequence } from '../data/sequenceDataSource';
import { orientSequenceForModel, restoreGenomicOrder } from '../lib/modelStrand';
import {
  averageRows,
  forwardAnchors,
  largestChange,
  mutagenesisOutputPositions,
  mutagenesisValue,
  mutantAbsoluteChange,
  mutantCurveBytes,
  mutantRecordToOverlay,
  quantizeUnit,
  referenceBaseIndex,
  writeMutant,
  type MutantCurveRecord,
  type MutantEffect,
} from '../lib/mutagenesis';
import { applyTranscriptPadding, transcriptPaddingIntervals, type TranscriptSpan } from '../lib/transcriptPadding';
import { canonicalTranscriptAnnotationUrl } from '../features/genome/demoData';
import { getReader, readBigBedRows } from '../data/bbiReader';

type OrtModule = typeof import('onnxruntime-web/wasm');

type OrtSessionHandle = {
  ort: OrtModule;
  session: Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;
};

type PackRunResult = {
  requestStart: number;
  requestEnd: number;
  /** Genomic interval the output samples actually span; see `deriveCoveredExtent`. */
  coveredStart: number;
  coveredEnd: number;
  outputSeries: Map<string, Float32Array>;
  /** Scores for inserted bases, which have no genomic coordinate to sit on. */
  insertedScores: Map<string, InsertedBaseScore[]>;
  /** Mutagenesis rows: per genomic base, the largest change the mean mutant made to the row's channel. */
  mutantEffects?: Map<string, Map<number, MutantEffect>>;
  spanBp: number;
  resolutionBp: number;
  constrainedByMaxWindow: boolean;
  constrainedByResolution: boolean;
};

type CompletedRunEntry = {
  key: string;
  packChrKey: string;
  requestStart: number;
  requestEnd: number;
  seriesKeys: ReadonlySet<string>;
  bytes: number;
  result: PackRunResult;
};

type InFlightRunMeta = {
  key: string;
  packChrKey: string;
  requestStart: number;
  requestEnd: number;
  seriesKeys: ReadonlySet<string>;
  request: Promise<PackRunResult>;
};

type RequestState = {
  aborted: boolean;
};

type QueuedComputation = {
  key: string;
  execute: () => Promise<PackRunResult>;
  resolve: (result: PackRunResult) => void;
  reject: (error: unknown) => void;
};

type WorkerHost = {
  postMessage: (message: ComputationalWorkerResponse) => void;
  onmessage: ((event: MessageEvent<ComputationalWorkerRequest>) => void) | null;
};

const workerScope = globalThis as unknown as WorkerHost;

const MAX_INFERENCE_CACHE_ENTRIES = 260;
const MAX_INFERENCE_CACHE_BYTES = 240 * 1024 * 1024;
const MAX_COMPUTATIONAL_CONCURRENCY = 1;
// Pending runs beyond this are dropped oldest-first. Sized for the mutagenesis
// lane, where one pan can queue an ISM run per row on both the reference and
// the edited sequence; at 8 a couple of pans starved the edited rows for good.
const MAX_PENDING_COMPUTATIONAL_REQUESTS = 32;

const sessionCache = new Map<string, Promise<OrtSessionHandle>>();
const inferenceCache = new Map<string, Promise<PackRunResult>>();
const completedRunStore = new Map<string, CompletedRunEntry>();
const completedRunsByPackChr = new Map<string, Set<string>>();
const inFlightRuns = new Map<string, InFlightRunMeta>();
const inFlightRunsByPackChr = new Map<string, Set<string>>();
const pendingComputations: QueuedComputation[] = [];
const requestStates = new Map<number, RequestState>();
/**
 * The live compute requests, so a run that has just finished a batch can turn
 * what it has so far into features for every request waiting on it.
 */
const computeRequests = new Map<number, ComputationalWorkerComputeRequest>();
// Which requests are waiting on each in-flight run. A long run (a mutagenesis)
// checks between batches whether anyone still wants it, and stops if not.
const inFlightWaiters = new Map<string, Set<number>>();

function addWaiter(key: string, requestId: number | undefined): void {
  if (requestId === undefined) {
    return;
  }
  const waiters = inFlightWaiters.get(key);
  if (waiters) {
    waiters.add(requestId);
  } else {
    inFlightWaiters.set(key, new Set([requestId]));
  }
}

/** True while at least one request waiting on this run has not been aborted. */
function runStillWanted(key: string): boolean {
  const waiters = inFlightWaiters.get(key);
  if (!waiters || waiters.size === 0) {
    return true;
  }
  for (const requestId of waiters) {
    const state = requestStates.get(requestId);
    if (state && !state.aborted) {
      return true;
    }
  }
  return false;
}

let ortModulePromise: Promise<OrtModule> | null = null;
let activeComputationalRuns = 0;
let totalInferenceCacheBytes = 0;

function postResponse(response: ComputationalWorkerResponse): void {
  workerScope.postMessage(response);
}

function resolvedUrl(url: string): string {
  if (typeof self === 'undefined' || !('location' in self)) {
    return url;
  }
  return new URL(url, self.location.href).toString();
}

/**
 * Threads need SharedArrayBuffer, which needs the page to be cross-origin
 * isolated (see the COOP/COEP headers in vite.config.ts). If isolation is missing
 * we must stay at 1 — asking for more would fail to initialize rather than
 * degrade. These models are convolutional and parallelize well, so this is the
 * difference between roughly one core and several.
 */
function resolveWasmThreadCount(): number {
  const isolated = typeof self !== 'undefined' && (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (!isolated || typeof SharedArrayBuffer === 'undefined') {
    return 1;
  }

  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  if (!Number.isFinite(cores) || !cores || cores < 2) {
    return 1;
  }

  // Leave headroom for the main thread and the browser's own work; past ~4 the
  // per-window graphs are small enough that sync overhead eats the gain.
  return Math.min(4, Math.max(1, cores - 1));
}

async function loadOrtModule(): Promise<OrtModule> {
  if (!ortModulePromise) {
    ortModulePromise = import('onnxruntime-web/wasm').then((ort) => {
      ort.env.logLevel = 'error';
      ort.env.wasm.numThreads = resolveWasmThreadCount();
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = {
        wasm: resolvedUrl('/ort/ort-wasm-simd-threaded.wasm'),
      };
      return ort;
    });
  }
  return ortModulePromise;
}

async function getSession(modelUrl: string): Promise<OrtSessionHandle> {
  const key = resolvedUrl(modelUrl);
  const cached = sessionCache.get(key);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const ort = await loadOrtModule();
    const session = await ort.InferenceSession.create(key, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { ort, session };
  })();

  sessionCache.set(key, request);
  try {
    return await request;
  } catch (error) {
    sessionCache.delete(key);
    throw error;
  }
}

function drainComputationQueue(): void {
  while (activeComputationalRuns < MAX_COMPUTATIONAL_CONCURRENCY && pendingComputations.length > 0) {
    const task = pendingComputations.pop();
    if (!task) {
      return;
    }
    // Nobody is waiting for this run any more (the view moved on before its
    // turn came): do not spend a session on it.
    if (!runStillWanted(task.key)) {
      inferenceCache.delete(task.key);
      task.reject(new DOMException('Computational request superseded by newer navigation', 'AbortError'));
      continue;
    }

    activeComputationalRuns += 1;
    task
      .execute()
      .then((result) => task.resolve(result))
      .catch((error) => task.reject(error))
      .finally(() => {
        activeComputationalRuns = Math.max(0, activeComputationalRuns - 1);
        drainComputationQueue();
      });
  }
}

function enqueueComputation(
  key: string,
  execute: () => Promise<PackRunResult>,
): Promise<PackRunResult> {
  return new Promise<PackRunResult>((resolve, reject) => {
    pendingComputations.push({ key, execute, resolve, reject });

    while (pendingComputations.length > MAX_PENDING_COMPUTATIONAL_REQUESTS) {
      const dropped = pendingComputations.shift();
      if (!dropped) {
        break;
      }
      inferenceCache.delete(dropped.key);
      dropped.reject(new DOMException('Computational request superseded by newer navigation', 'AbortError'));
    }

    drainComputationQueue();
  });
}

function touchInferenceCache(key: string, value: Promise<PackRunResult>): void {
  if (inferenceCache.has(key)) {
    inferenceCache.delete(key);
  }
  inferenceCache.set(key, value);

  while (inferenceCache.size > MAX_INFERENCE_CACHE_ENTRIES) {
    const firstKey = inferenceCache.keys().next().value;
    if (!firstKey) {
      return;
    }
    inferenceCache.delete(firstKey);
  }
}

function addIndexKey(index: Map<string, Set<string>>, scopeKey: string, entryKey: string): void {
  const existing = index.get(scopeKey);
  if (existing) {
    existing.add(entryKey);
    return;
  }
  index.set(scopeKey, new Set([entryKey]));
}

function removeIndexKey(index: Map<string, Set<string>>, scopeKey: string, entryKey: string): void {
  const existing = index.get(scopeKey);
  if (!existing) {
    return;
  }
  existing.delete(entryKey);
  if (existing.size === 0) {
    index.delete(scopeKey);
  }
}

function buildPackChrKey(
  pack: ComputationalPackManifest,
  chr: string,
  sequenceEdits?: readonly SequenceEdit[],
  reverseComplement = false,
): string {
  const flank = pack.inference?.flankBp ?? 0;
  const editsKey = serializeSequenceEdits(sequenceEdits);
  const strand = reverseComplement ? '-' : '+';
  return `${pack.id}|${resolvedUrl(pack.model.url)}|${pack.sequenceProvider.genome}|${chr}:flank${flank}:strand${strand}:edits${editsKey}`;
}

function buildInferenceKey(
  pack: ComputationalPackManifest,
  chr: string,
  spec: DataWindowSpec,
  outputSet: ComputationalOutputSet,
  sequenceEdits?: readonly SequenceEdit[],
  reverseComplement = false,
): string {
  const flank = pack.inference?.flankBp ?? 0;
  const editsKey = serializeSequenceEdits(sequenceEdits);
  const strand = reverseComplement ? '-' : '+';
  const focus = spec.focus ? `:focus${spec.focus.start}-${spec.focus.end}` : '';
  return `${pack.id}|${resolvedUrl(pack.model.url)}|${pack.sequenceProvider.genome}|${chr}:${spec.requestStart}:${spec.requestEnd}:flank${flank}:strand${strand}:outputs${outputSet.key}:edits${editsKey}${focus}`;
}

function estimateResultBytes(result: PackRunResult): number {
  let bytes = 0;
  for (const values of result.outputSeries.values()) {
    bytes += values.byteLength;
  }
  return bytes;
}

function touchCompletedRun(entry: CompletedRunEntry): void {
  if (completedRunStore.has(entry.key)) {
    completedRunStore.delete(entry.key);
  }
  completedRunStore.set(entry.key, entry);
}

function removeCompletedRun(entry: CompletedRunEntry): void {
  if (!completedRunStore.has(entry.key)) {
    return;
  }
  completedRunStore.delete(entry.key);
  removeIndexKey(completedRunsByPackChr, entry.packChrKey, entry.key);
  totalInferenceCacheBytes = Math.max(0, totalInferenceCacheBytes - entry.bytes);
}

function enforceCompletedRunLimits(): void {
  while (
    completedRunStore.size > MAX_INFERENCE_CACHE_ENTRIES ||
    totalInferenceCacheBytes > MAX_INFERENCE_CACHE_BYTES
  ) {
    const oldestKey = completedRunStore.keys().next().value;
    if (!oldestKey) {
      return;
    }
    const oldest = completedRunStore.get(oldestKey);
    if (!oldest) {
      completedRunStore.delete(oldestKey);
      continue;
    }
    removeCompletedRun(oldest);
  }
}

function storeCompletedRun(entry: CompletedRunEntry): void {
  const existing = completedRunStore.get(entry.key);
  if (existing) {
    removeCompletedRun(existing);
  }
  addIndexKey(completedRunsByPackChr, entry.packChrKey, entry.key);
  totalInferenceCacheBytes += entry.bytes;
  touchCompletedRun(entry);
  enforceCompletedRunLimits();
}

function selectBestCoveringKey<T extends { requestStart: number; requestEnd: number }>(
  entries: T[],
  requestStart: number,
  requestEnd: number,
): T | null {
  let best: T | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  let bestOverfetch = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    if (entry.requestStart > requestStart || entry.requestEnd < requestEnd) {
      continue;
    }

    const span = Math.max(1, entry.requestEnd - entry.requestStart);
    const overfetch = span - (requestEnd - requestStart);

    if (span < bestSpan || (span === bestSpan && overfetch < bestOverfetch)) {
      best = entry;
      bestSpan = span;
      bestOverfetch = overfetch;
    }
  }

  return best;
}

function findCoveringCompletedRun(
  pack: ComputationalPackManifest,
  chr: string,
  spec: DataWindowSpec,
  outputSet: ComputationalOutputSet,
  sequenceEdits?: readonly SequenceEdit[],
  reverseComplement = false,
): CompletedRunEntry | null {
  // Edited windows and focused (mutagenesis) windows are only ever exact
  // matches: a wider run that covers the range did not do this work.
  if ((sequenceEdits && sequenceEdits.length > 0) || spec.focus) {
    return null;
  }
  const scopeKey = buildPackChrKey(pack, chr, sequenceEdits, reverseComplement);
  const keys = completedRunsByPackChr.get(scopeKey);
  if (!keys || keys.size === 0) {
    return null;
  }

  const candidates: CompletedRunEntry[] = [];
  for (const key of keys) {
    const entry = completedRunStore.get(key);
    if (!entry) {
      continue;
    }
    if (entry.result.constrainedByMaxWindow || entry.result.constrainedByResolution) {
      continue;
    }
    if (!computationalOutputSetCovers(entry.seriesKeys, outputSet.seriesKeys)) {
      continue;
    }
    candidates.push(entry);
  }

  return selectBestCoveringKey(candidates, spec.requestStart, spec.requestEnd);
}

function findCoveringInFlightRun(
  pack: ComputationalPackManifest,
  chr: string,
  spec: DataWindowSpec,
  outputSet: ComputationalOutputSet,
  sequenceEdits?: readonly SequenceEdit[],
  reverseComplement = false,
): Promise<PackRunResult> | null {
  // Edited windows and focused (mutagenesis) windows are only ever exact
  // matches: a wider run that covers the range did not do this work.
  if ((sequenceEdits && sequenceEdits.length > 0) || spec.focus) {
    return null;
  }
  const scopeKey = buildPackChrKey(pack, chr, sequenceEdits, reverseComplement);
  const keys = inFlightRunsByPackChr.get(scopeKey);
  if (!keys || keys.size === 0) {
    return null;
  }

  const candidates: InFlightRunMeta[] = [];
  for (const key of keys) {
    const entry = inFlightRuns.get(key);
    if (!entry) {
      continue;
    }
    if (!computationalOutputSetCovers(entry.seriesKeys, outputSet.seriesKeys)) {
      continue;
    }
    candidates.push(entry);
  }

  const best = selectBestCoveringKey(candidates, spec.requestStart, spec.requestEnd);
  return best?.request ?? null;
}

function toFiniteFloat(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function toFloatArray(data: unknown): Float32Array {
  if (data instanceof Float32Array) {
    return data;
  }
  if (data instanceof Float64Array || data instanceof Int32Array || data instanceof Uint32Array) {
    return Float32Array.from(data, (item) => toFiniteFloat(Number(item)));
  }
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    return Float32Array.from(data, (item) => toFiniteFloat(Number(item)));
  }
  if (Array.isArray(data)) {
    return Float32Array.from(data, (item) => toFiniteFloat(Number(item)));
  }
  return new Float32Array(0);
}

function extractSeriesFromTensor(
  tensor: { data?: unknown; dims?: readonly number[] },
  channelIndex = 0,
): Float32Array {
  const dims = Array.isArray(tensor.dims) ? tensor.dims.map((value) => Math.max(1, Math.floor(value))) : [];
  const values = toFloatArray(tensor.data);
  if (values.length === 0 || dims.length === 0) {
    return values;
  }

  const positionLength = dims[dims.length - 1] ?? values.length;
  if (!Number.isFinite(positionLength) || positionLength <= 0) {
    return values;
  }

  if (dims.length === 1) {
    return values.length === positionLength ? values : values.slice(0, positionLength);
  }

  const prefixCount = dims.slice(0, -1).reduce((acc, item) => acc * Math.max(1, item), 1);
  const safePrefixCount = Math.max(1, prefixCount);
  const safeChannelIndex = clamp(Math.floor(channelIndex), 0, safePrefixCount - 1);
  const offset = safeChannelIndex * positionLength;
  const boundedOffset = clamp(offset, 0, Math.max(0, values.length - positionLength));
  return values.slice(boundedOffset, boundedOffset + positionLength);
}

function applyTransform(values: Float32Array, transform: ComputationalSubtrackSpec['transform']): Float32Array {
  if (!transform || transform === 'identity') {
    return values;
  }

  const next = new Float32Array(values.length);
  if (transform === 'abs') {
    for (let index = 0; index < values.length; index += 1) {
      next[index] = Math.abs(values[index] ?? 0);
    }
    return next;
  }

  for (let index = 0; index < values.length; index += 1) {
    next[index] = Math.max(0, values[index] ?? 0);
  }
  return next;
}

/**
 * Canonical transcript spans overlapping a window, for the N padding a
 * transcript model expects. A failed or absent annotation means no padding,
 * never a failed inference.
 */
async function canonicalTranscriptSpans(
  genome: string,
  chr: string,
  start: number,
  end: number,
): Promise<TranscriptSpan[]> {
  const url = canonicalTranscriptAnnotationUrl(genome);
  if (!url) {
    return [];
  }
  try {
    const rows = await readBigBedRows(getReader(url), chr, Math.max(0, start), end);
    return rows.flatMap((row) =>
      row.strand === '+' || row.strand === '-' ? [{ start: row.start, end: row.end, strand: row.strand }] : [],
    );
  } catch {
    return [];
  }
}

async function padTranscriptFlanks(
  sequence: string,
  pack: ComputationalPackManifest,
  chr: string,
  sequenceStart: number,
  strand: '+' | '-',
): Promise<string> {
  const padBp = pack.inference?.transcriptPadding?.bp;
  if (!padBp) {
    return sequence;
  }
  const sequenceEnd = sequenceStart + sequence.length;
  const spans = await canonicalTranscriptSpans(pack.sequenceProvider.genome, chr, sequenceStart - padBp, sequenceEnd + padBp);
  return applyTranscriptPadding(
    sequence,
    sequenceStart,
    transcriptPaddingIntervals(spans, strand, sequenceStart, sequenceEnd, padBp),
  );
}

async function runPack(
  pack: ComputationalPackManifest,
  chr: string,
  spec: DataWindowSpec,
  outputSet: ComputationalOutputSet,
  sequenceEdits?: readonly SequenceEdit[],
  reverseComplement = false,
  shouldContinue: () => boolean = () => true,
  /** Called with the result so far while a mutagenesis run is still going. */
  onPartial?: (partial: PackRunResult) => void,
): Promise<PackRunResult> {
  const spanBp = Math.max(1, spec.requestEnd - spec.requestStart);
  const resolutionBp = Math.max(1, Math.floor(spec.resolutionBp));
  const maxWindowBp = effectiveComputationalMaxWindowBp(pack);
  const maxResolutionBp = pack.inference?.maxResolutionBp;

  if (maxResolutionBp && resolutionBp > maxResolutionBp) {
    return {
      requestStart: spec.requestStart,
      requestEnd: spec.requestEnd,
      coveredStart: spec.requestStart,
      coveredEnd: spec.requestEnd,
      outputSeries: new Map<string, Float32Array>(),
      insertedScores: new Map<string, InsertedBaseScore[]>(),
      spanBp,
      resolutionBp,
      constrainedByMaxWindow: false,
      constrainedByResolution: true,
    };
  }

  if (spanBp > maxWindowBp) {
    return {
      requestStart: spec.requestStart,
      requestEnd: spec.requestEnd,
      coveredStart: spec.requestStart,
      coveredEnd: spec.requestEnd,
      outputSeries: new Map<string, Float32Array>(),
      insertedScores: new Map<string, InsertedBaseScore[]>(),
      spanBp,
      resolutionBp,
      constrainedByMaxWindow: true,
      constrainedByResolution: false,
    };
  }

  const flankBp = Math.max(0, pack.inference?.flankBp ?? 0);
  const sequenceStart = Math.max(0, spec.requestStart - flankBp);
  const sequenceEnd = spec.requestEnd + flankBp;
  if (sequenceEnd - sequenceStart > HARD_COMPUTATIONAL_MAX_SEQUENCE_BP) {
    return {
      requestStart: spec.requestStart,
      requestEnd: spec.requestEnd,
      coveredStart: spec.requestStart,
      coveredEnd: spec.requestEnd,
      outputSeries: new Map<string, Float32Array>(),
      insertedScores: new Map<string, InsertedBaseScore[]>(),
      spanBp,
      resolutionBp,
      constrainedByMaxWindow: true,
      constrainedByResolution: false,
    };
  }

  const genomic = await fetchGenomeSequence({
    genome: pack.sequenceProvider.genome,
    chr,
    start: sequenceStart,
    end: sequenceEnd,
  });
  // A transcript model reads N beyond a canonical transcript's ends, as in
  // training. Applied to the reference, before edits, on the strand scored.
  const sequence = await padTranscriptFlanks(genomic, pack, chr, sequenceStart, reverseComplement ? '-' : '+');

  let modelSequence = sequence;
  let genomicPositions: (number | null)[] | null = null;
  if (sequenceEdits && sequenceEdits.length > 0) {
    const edited = applyEditsToSequence(sequence, sequenceStart, sequenceEdits);
    modelSequence = edited.sequence;
    genomicPositions = edited.genomicPositions;
  }
  const seqLength = modelSequence.length;
  const { coveredStart, coveredEnd } = deriveCoveredExtent({
    sequenceStart,
    sequenceLength: sequence.length,
    flankBp,
    requestStart: spec.requestStart,
    requestEnd: spec.requestEnd,
  });
  const minModelLength = Math.max(2, 2 * flankBp + 1);
  if (seqLength < minModelLength || seqLength > HARD_COMPUTATIONAL_MAX_SEQUENCE_BP) {
    return {
      requestStart: spec.requestStart,
      requestEnd: spec.requestEnd,
      coveredStart,
      coveredEnd,
      outputSeries: new Map<string, Float32Array>(),
      insertedScores: new Map<string, InsertedBaseScore[]>(),
      spanBp,
      resolutionBp,
      constrainedByMaxWindow: seqLength > HARD_COMPUTATIONAL_MAX_SEQUENCE_BP,
      constrainedByResolution: false,
    };
  }

  // Reverse-complemented AFTER the edits, so genomicPositions stays in forward
  // order; the outputs are flipped back to match below.
  const encodedSequence = encodeDnaOneHotNcl(orientSequenceForModel(modelSequence, reverseComplement));
  const { ort, session } = await getSession(pack.model.url);
  const inputName = pack.model.inputName ?? session.inputNames[0];
  if (!inputName) {
    throw new Error(`Computational model "${pack.name}" does not expose input names.`);
  }

  const feeds: Record<string, InstanceType<OrtModule['Tensor']>> = {
    [inputName]: new ort.Tensor('float32', encodedSequence, [1, 4, seqLength]),
  };
  const fixedInputs = pack.model.fixedInputs ?? {};
  for (const [name, scalar] of Object.entries(fixedInputs)) {
    feeds[name] = new ort.Tensor('float32', new Float32Array([scalar]), [1]);
  }

  const runStartedAt = performance.now();
  const rawResults = (await session.run(feeds, [...outputSet.outputNames])) as Record<string, { data?: unknown; dims?: readonly number[] }>;
  // Refine this model's cost from the real run without forcing a re-render; the
  // gate reads the latest value the next time it recomputes.
  if (seqLength > 0) {
    recordInferenceCalibration(pack.model.url, (performance.now() - runStartedAt) / seqLength, {
      notify: false,
    });
  }

  const outputSeries = new Map<string, Float32Array>();
  const insertedScores = new Map<string, InsertedBaseScore[]>();
  for (const subtrack of outputSet.subtracks) {
    const seriesKey = computationalSeriesKey(subtrack);
    if (outputSeries.has(seriesKey)) {
      continue;
    }
    // A mutagenesis row mutates its output rather than reading it; derived below.
    if (subtrack.mutagenesis) {
      continue;
    }
    const outputTensor = rawResults[subtrack.outputName];
    if (!outputTensor) {
      throw new Error(`Computational model "${pack.name}" did not return output "${subtrack.outputName}".`);
    }
    const values = restoreGenomicOrder(
      extractSeriesFromTensor(outputTensor, subtrack.channelIndex ?? 0),
      reverseComplement,
    );
    outputSeries.set(
      seriesKey,
      genomicPositions
        ? remapEditedScoresToGenomic(values, genomicPositions, flankBp, coveredStart, coveredEnd)
        : values,
    );
    if (genomicPositions) {
      insertedScores.set(seriesKey, extractInsertedScores(values, genomicPositions, flankBp));
    }
  }

  // Mutagenesis rows are derived from the reference run above, for the focused
  // bases only. Rows that mutate the same output with the same parameters share
  // one mutant batch, whichever channel each of them reads: the batch produces
  // every channel anyway, and every one is cached.
  // Everything the run has produced so far. A partial is the same object as the
  // final answer, read earlier: its series simply have fewer bases in them, and
  // the rest are NaN, which the row draws as nothing.
  let lastPartialAt = 0;
  let mutantEffectsForResult: PackRunResult['mutantEffects'];
  const buildResult = (): PackRunResult => ({
    requestStart: spec.requestStart,
    requestEnd: spec.requestEnd,
    coveredStart,
    coveredEnd,
    outputSeries,
    insertedScores,
    mutantEffects: mutantEffectsForResult,
    spanBp,
    resolutionBp,
    constrainedByMaxWindow: false,
    constrainedByResolution: false,
  });
  const mutagenesisSubtracks = outputSet.subtracks.filter((subtrack) => subtrack.mutagenesis);
  if (mutagenesisSubtracks.length > 0) {
    const groups = new Map<string, ComputationalSubtrackSpec[]>();
    for (const subtrack of mutagenesisSubtracks) {
      const { contextBp } = subtrack.mutagenesis!;
      const groupKey = `${subtrack.outputName}|${contextBp}`;
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), subtrack]);
    }
    const fixedFeeds = Object.fromEntries(Object.entries(feeds).filter(([name]) => name !== inputName));
    const effectsBySeries = new Map<string, Map<number, MutantEffect>>();

    for (const group of groups.values()) {
      const lead = group[0]!;
      const { contextBp } = lead.mutagenesis!;
      const reference = rawResults[lead.outputName];
      if (!reference) {
        throw new Error(`Computational model "${pack.name}" did not return output "${lead.outputName}".`);
      }
      const dims = Array.isArray(reference.dims) ? reference.dims.map((value) => Math.max(1, Math.floor(value))) : [];
      const outputLength = dims[dims.length - 1] ?? 0;
      const channelCount = dims.length >= 2 ? dims[dims.length - 2]! : 1;
      const interiorStart = Math.max(0, Math.floor((seqLength - outputLength) / 2));
      const focus = spec.focus;

      let perChannel: Float32Array[] = [];
      let details = new Map<number, MutagenesisDetail>();
      const genomicOfOutput = (position: number): number | null => {
        const forward = reverseComplement ? outputLength - 1 - position : position;
        return genomicPositions ? genomicPositions[interiorStart + forward] ?? null : coveredStart + forward;
      };
      const publishGroupSeries = (
        channels: readonly Float32Array[],
        detailsNow: Map<number, MutagenesisDetail>,
      ) => {
      for (const subtrack of group) {
        const seriesKey = computationalSeriesKey(subtrack);
        const channelValues = channels[subtrack.channelIndex ?? 0];
        if (!channelValues) {
          // Past the row's declared width nothing was computed: an empty series,
          // so the row can say so rather than draw a run of zeros.
          outputSeries.set(seriesKey, new Float32Array(0));
          continue;
        }
        const channel = subtrack.channelIndex ?? 0;
        const byGenomic = new Map<number, MutantEffect>();
        for (const [position, detail] of detailsNow) {
          const genomic = genomicOfOutput(position);
          if (genomic === null) {
            continue;
          }
          byGenomic.set(genomic, {
            offset: detail.effects[channel * 3] ?? 0,
            reference: detail.effects[channel * 3 + 1] ?? 0,
            mutant: detail.effects[channel * 3 + 2] ?? 0,
          });
        }
        effectsBySeries.set(seriesKey, byGenomic);
        mutantEffectsForResult = effectsBySeries;
        const values = restoreGenomicOrder(channelValues, reverseComplement);
        outputSeries.set(
          seriesKey,
          genomicPositions
            ? remapEditedScoresToGenomic(values, genomicPositions, flankBp, coveredStart, coveredEnd)
            : values,
        );
        if (genomicPositions) {
          insertedScores.set(seriesKey, extractInsertedScores(values, genomicPositions, flankBp));
        }
      }
      };

      if (focus && outputLength > 0) {
        const positions = mutagenesisOutputPositions({
          focusStart: focus.start,
          focusEnd: focus.end,
          coveredStart,
          genomicPositions,
          interiorStart,
          outputLength,
          reverseComplement,
        });
        const scope = mutagenesisScope(pack, chr, reverseComplement, sequenceEdits, lead.outputName, contextBp);
        const mutagenesis = await runMutagenesis({
          ort,
          session,
          inputName,
          fixedFeeds,
          outputName: lead.outputName,
          encodedSequence,
          seqLength,
          reference: toFloatArray(reference.data),
          channelCount,
          outputLength,
          interiorStart,
          positions,
          cacheKeyFor: (position) => {
            const genomic = genomicOfOutput(position);
            return genomic === null ? null : `${scope}|${genomic}`;
          },
          reverseComplement,
          // Every position's column, so the hover of an edited window lands on
          // its inserted bases as well as its genomic ones: one rule for both.
          ...forwardAnchors(genomicPositions, interiorStart, outputLength, coveredStart),
          contextBp,
          shouldContinue,
          // A mutagenesis run takes seconds, and every batch of 32 bases is a
          // stretch of row that could already be on screen. Reporting them as
          // they land costs nothing -- the values are computed either way --
          // and it is the difference between a row that fills in and a row that
          // sits empty until the whole screen is done. Throttled, because
          // rebuilding the features is work of its own.
          onProgress: onPartial
            ? (valuesNow, detailsNow) => {
                const now = Date.now();
                if (now - lastPartialAt < MUTAGENESIS_PARTIAL_INTERVAL_MS) {
                  return;
                }
                lastPartialAt = now;
                publishGroupSeries(valuesNow, detailsNow);
                onPartial(buildResult());
              }
            : undefined,
        });
        perChannel = mutagenesis.values;
        details = mutagenesis.details;
      }

      publishGroupSeries(perChannel, details);
    }
  }

  return buildResult();
}

/**
 * Bases per mutant batch: three mutants each, so 24 sequences per session run.
 *
 * The batch is what the row fills in by, because a session run blocks this
 * worker until it returns, and it is also how often an abandoned run notices
 * (checked between batches). It used to be 32 bases, which is half a second of
 * work: the row filled in visible steps and a pan waited that long to be
 * obeyed. These graphs are small enough that a shorter call is not a worse
 * one -- measured over the same 200 bp run, 32 bases settles in 6.06 s, 8 in
 * 5.75 s and 4 in 5.74 s, all within noise of each other -- so the batch is
 * sized for the eye instead, at about an eighth of a second.
 */
const MUTAGENESIS_BATCH_BASES = 8;
/**
 * The most often a run in progress reports what it has. A cap, not a cadence:
 * batches longer than this publish as they land, and a run whose bases are
 * mostly cached does not rebuild the features for every one of them. At 100 ms
 * a run publishes about eight times a second, which reads as continuous; 60 ms
 * measured the same on the clock and twice the messages for nothing the eye
 * can see.
 */
const MUTAGENESIS_PARTIAL_INTERVAL_MS = 100;
const MUTAGENESIS_CACHE_MAX_ENTRIES = 200_000;
/**
 * Per-base mutagenesis results, one small array of channels each, keyed by
 * pack, strand, edits, parameters and coordinate. Panning at letters zoom then
 * re-scores only the bases that are new to the screen. A base scored in a
 * different request window saw slightly different context and a possibly
 * different set of sites near the window edge; that is accepted.
 */
type MutagenesisCacheEntry = {
  /** Mean summed absolute change per channel. */
  values: Float32Array;
  /**
   * `effects[channel * 3 + {0, 1, 2}]`: offset from the base (as read), reference
   * value and mean-mutant value of the largest change the mean mutant made.
   * An offset, not an output index: this entry outlives the window it came from.
   */
  effects: Float32Array;
};
const mutagenesisCache = new Map<string, MutagenesisCacheEntry>();

function rememberMutagenesis(key: string, entry: MutagenesisCacheEntry): void {
  if (mutagenesisCache.has(key)) {
    mutagenesisCache.delete(key);
  }
  mutagenesisCache.set(key, entry);
  if (mutagenesisCache.size > MUTAGENESIS_CACHE_MAX_ENTRIES) {
    const oldest = mutagenesisCache.keys().next().value;
    if (oldest !== undefined) {
      mutagenesisCache.delete(oldest);
    }
  }
}

/**
 * The three mutant predictions per scored base, for the hover overlay: what
 * each substitution actually predicts around the base, not only how much it
 * changed. Quantised and clipped to the context, ~12 KB a base for two
 * channels; capped by bytes, oldest out first.
 */
const MUTANT_CURVE_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const mutantCurveCache = new Map<string, MutantCurveRecord>();
let mutantCurveCacheBytes = 0;

function rememberMutantCurves(key: string, record: MutantCurveRecord): void {
  const existing = mutantCurveCache.get(key);
  if (existing) {
    mutantCurveCacheBytes -= mutantCurveBytes(existing);
    mutantCurveCache.delete(key);
  }
  mutantCurveCache.set(key, record);
  mutantCurveCacheBytes += mutantCurveBytes(record);
  while (mutantCurveCacheBytes > MUTANT_CURVE_CACHE_MAX_BYTES && mutantCurveCache.size > 1) {
    const oldest = mutantCurveCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    const dropped = mutantCurveCache.get(oldest);
    mutantCurveCache.delete(oldest);
    if (dropped) {
      mutantCurveCacheBytes -= mutantCurveBytes(dropped);
    }
  }
}

/** One identity for a mutagenesis row's per-base caches, shared by the run and the hover lookup. */
function mutagenesisScope(
  pack: ComputationalPackManifest,
  chr: string,
  reverseComplement: boolean,
  sequenceEdits: readonly SequenceEdit[] | undefined,
  outputName: string,
  contextBp: number,
): string {
  const strand = reverseComplement ? '-' : '+';
  return `${pack.id}|${resolvedUrl(pack.model.url)}|${pack.sequenceProvider.genome}|${chr}|strand${strand}` +
    `|edits${serializeSequenceEdits(sequenceEdits)}|${outputName}|abs|ctx${contextBp}`;
}

type MutagenesisRun = {
  ort: OrtModule;
  session: OrtSessionHandle['session'];
  inputName: string;
  fixedFeeds: Record<string, InstanceType<OrtModule['Tensor']>>;
  outputName: string;
  /** The reference one-hot, [4, L], in the model's orientation. */
  encodedSequence: Float32Array;
  seqLength: number;
  /** The reference prediction, [C, out], in the model's orientation. */
  reference: Float32Array;
  channelCount: number;
  outputLength: number;
  /** Output position 0 is this input position. */
  interiorStart: number;
  /** Output positions to mutate, in the model's orientation. */
  positions: readonly number[];
  cacheKeyFor: (position: number) => string | null;
  reverseComplement: boolean;
  /** Each output position's column, in forward order (see forwardAnchors). */
  anchors: Int32Array;
  insertOffsets: Int16Array;
  contextBp: number;
  /** Checked between batches; false when every request waiting on this run is gone. */
  shouldContinue: () => boolean;
  /** Called after each batch with the values so far, for a row that fills in. */
  onProgress?: (values: Float32Array[], details: Map<number, MutagenesisDetail>) => void;
};

type MutagenesisDetail = { effects: Float32Array };

/**
 * Exact in silico saturation mutagenesis of the focused bases: every one is
 * substituted by the other three in turn and the whole window re-scored, in
 * batches through the same graph. Each base's value is the mean over its three
 * substitutions of the summed absolute change in probability within the
 * context. For the hover, each base also keeps what the mean of its three
 * mutants predicts around it, every channel, and the largest change that mean
 * made. Returns one series per channel in the model's orientation, NaN where
 * nothing was computed.
 */
async function runMutagenesis(
  run: MutagenesisRun,
): Promise<{ values: Float32Array[]; details: Map<number, MutagenesisDetail> }> {
  const { channelCount, outputLength, seqLength } = run;
  const values: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    values.push(new Float32Array(outputLength).fill(Number.NaN));
  }
  const details = new Map<number, MutagenesisDetail>();
  const pending: number[] = [];
  for (const position of run.positions) {
    const key = run.cacheKeyFor(position);
    const cached = key === null ? undefined : mutagenesisCache.get(key);
    if (cached && cached.values.length === channelCount) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        values[channel]![position] = cached.values[channel]!;
      }
      details.set(position, { effects: cached.effects });
      continue;
    }
    pending.push(position);
  }

  run.onProgress?.(values, details);

  const strideFloats = 4 * seqLength;
  for (let from = 0; from < pending.length; from += MUTAGENESIS_BATCH_BASES) {
    // The view moved on and nobody is waiting for this screen any more. The
    // bases already scored are in the per-base cache; the rest can wait for a
    // screen that wants them.
    if (from > 0 && !run.shouldContinue()) {
      throw new DOMException('Mutagenesis superseded by newer navigation', 'AbortError');
    }
    const chunk = pending.slice(from, from + MUTAGENESIS_BATCH_BASES);
    const batch = new Float32Array(chunk.length * 3 * strideFloats);
    // Each position's mutants, by their index in the batch, and the letters tried.
    const mutantsAt = new Map<number, number[]>();
    const refBaseAt = new Map<number, number>();
    const altsAt = new Map<number, string>();
    let mutantCount = 0;
    for (const position of chunk) {
      const inputIndex = position + run.interiorStart;
      const refBase = referenceBaseIndex(run.encodedSequence, seqLength, inputIndex);
      if (refBase < 0) {
        // An N has nothing to be mutated from; it contributes nothing.
        for (let channel = 0; channel < channelCount; channel += 1) {
          values[channel]![position] = 0;
        }
        continue;
      }
      refBaseAt.set(position, refBase);
      const indices: number[] = [];
      let alts = '';
      for (let altBase = 0; altBase < 4; altBase += 1) {
        if (altBase === refBase) {
          continue;
        }
        writeMutant(batch, mutantCount * strideFloats, run.encodedSequence, seqLength, inputIndex, refBase, altBase);
        indices.push(mutantCount);
        mutantCount += 1;
        alts += 'ACGT'[altBase];
      }
      mutantsAt.set(position, indices);
      altsAt.set(position, alts);
    }
    if (mutantCount === 0) {
      continue;
    }

    const input = mutantCount * strideFloats === batch.length ? batch : batch.slice(0, mutantCount * strideFloats);
    const feeds = {
      ...run.fixedFeeds,
      [run.inputName]: new run.ort.Tensor('float32', input, [mutantCount, 4, seqLength]),
    };
    const results = (await run.session.run(feeds, [run.outputName])) as Record<string, { data?: unknown; dims?: readonly number[] }>;
    const tensor = results[run.outputName];
    if (!tensor) {
      throw new Error(`Mutagenesis run did not return output "${run.outputName}".`);
    }
    const output = toFloatArray(tensor.data);
    if (output.length !== mutantCount * channelCount * outputLength) {
      throw new Error(
        `Mutagenesis output has ${output.length} values; expected ${mutantCount} x ${channelCount} x ${outputLength}.`,
      );
    }

    for (const [position, indices] of mutantsAt) {
      const perBase = new Float32Array(channelCount);
      const effects = new Float32Array(channelCount * 3);
      const lo = Math.max(0, position - run.contextBp);
      const hi = Math.min(outputLength - 1, position + run.contextBp);
      const length = hi - lo + 1;
      const means: Float32Array[] = [];
      for (let channel = 0; channel < channelCount; channel += 1) {
        const rows = indices.map((mutant) => (mutant * channelCount + channel) * outputLength);
        let summed = 0;
        for (const row of rows) {
          summed += mutantAbsoluteChange(output, row, run.reference, channel * outputLength, position, run.contextBp, outputLength);
        }
        perBase[channel] = mutagenesisValue(summed, rows.length);
        values[channel]![position] = perBase[channel]!;
        // What the three mutants predict on average, and where that moved most.
        const mean = averageRows(output, rows, lo, length);
        means.push(mean);
        const peak = largestChange(mean, 0, run.reference, channel * outputLength + lo, length);
        // Model orientation runs along the strand read, so + is downstream --
        // to the right on screen on either strand.
        effects[channel * 3] = lo + peak.index - position;
        effects[channel * 3 + 1] = peak.reference;
        effects[channel * 3 + 2] = peak.value;
      }
      details.set(position, { effects });
      const key = run.cacheKeyFor(position);
      if (key === null) {
        continue;
      }
      rememberMutagenesis(key, { values: perBase, effects });

      // The mean mutant around this base, for the hover: forward (display)
      // order, with each position's column, so it lands where the rows draw.
      const forwardOf = (series: Float32Array): Float32Array =>
        run.reverseComplement ? series.slice().reverse() : series;
      const reference = new Uint16Array(channelCount * length);
      const mean = new Uint16Array(channelCount * length);
      for (let channel = 0; channel < channelCount; channel += 1) {
        const start = channel * outputLength + lo;
        quantizeUnit(forwardOf(run.reference.slice(start, start + length)), reference, channel * length);
        quantizeUnit(forwardOf(means[channel]!), mean, channel * length);
      }
      const forwardLo = run.reverseComplement ? outputLength - 1 - hi : lo;
      rememberMutantCurves(key, {
        refBase: 'ACGT'[refBaseAt.get(position) ?? 0] ?? 'N',
        alts: altsAt.get(position) ?? '',
        length,
        channelCount,
        anchors: run.anchors.slice(forwardLo, forwardLo + length),
        insertOffsets: run.insertOffsets.slice(forwardLo, forwardLo + length),
        reference,
        mean,
      });
    }
    run.onProgress?.(values, details);
  }

  return { values, details };
}

function getOrCreatePackRun(
  pack: ComputationalPackManifest,
  chr: string,
  spec: DataWindowSpec,
  outputSet: ComputationalOutputSet,
  sequenceEdits?: readonly SequenceEdit[],
  reverseComplement = false,
  requestId?: number,
): Promise<PackRunResult> {
  const key = buildInferenceKey(pack, chr, spec, outputSet, sequenceEdits, reverseComplement);
  const existing = inferenceCache.get(key);
  if (existing) {
    touchInferenceCache(key, existing);
    addWaiter(key, requestId);
    return existing;
  }

  const coveringCompleted = findCoveringCompletedRun(pack, chr, spec, outputSet, sequenceEdits, reverseComplement);
  if (coveringCompleted) {
    touchCompletedRun(coveringCompleted);
    return Promise.resolve(coveringCompleted.result);
  }

  const coveringInFlight = findCoveringInFlightRun(pack, chr, spec, outputSet, sequenceEdits, reverseComplement);
  if (coveringInFlight) {
    return coveringInFlight;
  }

  const packChrKey = buildPackChrKey(pack, chr, sequenceEdits, reverseComplement);
  addWaiter(key, requestId);
  // One run can serve several requests, and each wants the series it displays,
  // in its own window, at its own resolution. So a partial is converted per
  // waiter, exactly as the final result is.
  const emitPartial = (partial: PackRunResult) => {
    for (const waiterId of inFlightWaiters.get(key) ?? []) {
      const state = requestStates.get(waiterId);
      const waiting = computeRequests.get(waiterId);
      if (!state || state.aborted || !waiting) {
        continue;
      }
      postResponse({ type: 'partial', requestId: waiterId, features: featuresFromRun(partial, waiting) });
    }
  };
  const scheduledRequest = enqueueComputation(key, () =>
    runPack(pack, chr, spec, outputSet, sequenceEdits, reverseComplement, () => runStillWanted(key), emitPartial),
  )
    .then((result) => {
      if (!result.constrainedByMaxWindow && !result.constrainedByResolution) {
        storeCompletedRun({
          key,
          packChrKey,
          requestStart: result.requestStart,
          requestEnd: result.requestEnd,
          seriesKeys: outputSet.seriesKeys,
          bytes: estimateResultBytes(result),
          result,
        });
      }
      return result;
    })
    .catch((error) => {
      inferenceCache.delete(key);
      throw error;
    })
    .finally(() => {
      const inFlight = inFlightRuns.get(key);
      if (inFlight) {
        removeIndexKey(inFlightRunsByPackChr, inFlight.packChrKey, key);
      }
      inFlightRuns.delete(key);
      inferenceCache.delete(key);
      inFlightWaiters.delete(key);
    });

  inFlightRuns.set(key, {
    key,
    packChrKey,
    requestStart: spec.requestStart,
    requestEnd: spec.requestEnd,
    seriesKeys: outputSet.seriesKeys,
    request: scheduledRequest,
  });
  addIndexKey(inFlightRunsByPackChr, packChrKey, key);
  touchInferenceCache(key, scheduledRequest);
  return scheduledRequest;
}

type SlicedSeries = {
  values: Float32Array;
  startBp: number;
  endBp: number;
};

function sliceSeriesForRange(
  values: Float32Array,
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): SlicedSeries {
  if (values.length === 0) {
    return { values, startBp: sourceStart, endBp: sourceEnd };
  }

  const boundedStart = clamp(targetStart, sourceStart, Math.max(sourceStart, sourceEnd - 1));
  const boundedEnd = clamp(targetEnd, boundedStart + 1, sourceEnd);
  if (boundedStart <= sourceStart && boundedEnd >= sourceEnd) {
    return { values, startBp: sourceStart, endBp: sourceEnd };
  }

  const sourceSpanBp = Math.max(1, sourceEnd - sourceStart);
  const valueLength = Math.max(1, values.length);
  const fromRatio = (boundedStart - sourceStart) / sourceSpanBp;
  const toRatio = (boundedEnd - sourceStart) / sourceSpanBp;
  const from = clamp(Math.floor(fromRatio * valueLength), 0, valueLength - 1);
  const toExclusive = clamp(Math.ceil(toRatio * valueLength), from + 1, valueLength);

  // Report the interval the returned samples really span. Rounding `from`/`to` to
  // whole samples widens it slightly, and binning must use the widened interval
  // or every bin drifts.
  return {
    values: values.subarray(from, toExclusive),
    startBp: sourceStart + (from / valueLength) * sourceSpanBp,
    endBp: sourceStart + (toExclusive / valueLength) * sourceSpanBp,
  };
}

async function computeFeatures(request: ComputationalWorkerComputeRequest): Promise<TrackFeature[]> {
  const maxResolutionBp = request.source.pack.inference?.maxResolutionBp;
  if (maxResolutionBp && Math.max(1, Math.floor(request.spec.resolutionBp)) > maxResolutionBp) {
    return [];
  }

  const displaySubtracks = resolveComputationalTrackSubtracks(request.source);
  const outputSet = resolveComputationalOutputSetForSubtracks(request.source.pack, displaySubtracks);
  const run = await getOrCreatePackRun(
    request.source.pack,
    request.chr,
    request.spec,
    outputSet,
    request.source.sequenceEdits,
    request.source.reverseComplement === true,
    request.requestId,
  );
  if (run.constrainedByMaxWindow || run.constrainedByResolution) {
    return [];
  }

  return featuresFromRun(run, request);
}

/**
 * A run's series as one request's features. Pure, and called on a run that is
 * still going as well as on a finished one: a partial run has NaN where it has
 * not reached yet, and those bases simply produce no features.
 */
function featuresFromRun(
  run: PackRunResult,
  request: ComputationalWorkerComputeRequest,
): TrackFeature[] {
  const displaySubtracks = resolveComputationalTrackSubtracks(request.source);
  const features: TrackFeature[] = [];
  const usesSeriesIndices = displaySubtracks.length > 1;
  for (let seriesIndex = 0; seriesIndex < displaySubtracks.length; seriesIndex += 1) {
    const subtrack = displaySubtracks[seriesIndex];
    if (!subtrack) {
      continue;
    }
    const values = run.outputSeries.get(computationalSeriesKey(subtrack));
    if (!values || values.length === 0) {
      continue;
    }

    const sliced = sliceSeriesForRange(
      values,
      run.coveredStart,
      run.coveredEnd,
      request.spec.requestStart,
      request.spec.requestEnd,
    );
    const transformed = applyTransform(sliced.values, subtrack.transform);
    const seriesFeatures = seriesToBinnedFeatures(
      transformed,
      Math.round(sliced.startBp),
      Math.round(sliced.endBp),
      request.spec.resolutionBp,
      usesSeriesIndices ? seriesIndex : undefined,
    );
    // At base resolution a mutagenesis row's features carry the largest change
    // the mean of the base's three mutants made, for the hover label.
    const perBase = Math.max(1, Math.floor(request.spec.resolutionBp)) === 1
      ? run.mutantEffects?.get(computationalSeriesKey(subtrack))
      : undefined;
    for (const feature of seriesFeatures) {
      if (perBase && feature.end - feature.start <= 1) {
        const effect = perBase.get(Math.round(feature.start));
        if (effect) {
          feature.mutantEffect = effect;
        }
      }
      features.push(feature);
    }

    // Inserted bases ride along as their own features, tagged with the run they
    // belong to. Only worth emitting at base resolution, which is the only zoom
    // where the display has a column to put them in.
    if (Math.max(1, Math.floor(request.spec.resolutionBp)) === 1) {
      for (const inserted of run.insertedScores.get(computationalSeriesKey(subtrack)) ?? []) {
        if (inserted.before < request.spec.requestStart || inserted.before > request.spec.requestEnd) {
          continue;
        }
        const feature: TrackFeature = {
          start: inserted.before,
          end: inserted.before + 1,
          score: inserted.value,
          insertionBefore: inserted.before,
          insertionOffset: inserted.offset,
        };
        if (usesSeriesIndices) {
          feature.seriesIndex = seriesIndex;
        }
        features.push(feature);
      }
    }
  }
  return features;
}

async function handleCompute(request: ComputationalWorkerComputeRequest): Promise<void> {
  const state = requestStates.get(request.requestId);
  if (!state || state.aborted) {
    return;
  }
  computeRequests.set(request.requestId, request);

  try {
    const features = await computeFeatures(request);
    const latest = requestStates.get(request.requestId);
    if (!latest || latest.aborted) {
      return;
    }
    requestStates.delete(request.requestId);
    computeRequests.delete(request.requestId);
    postResponse({
      type: 'result',
      requestId: request.requestId,
      features,
    });
  } catch (error: unknown) {
    const latest = requestStates.get(request.requestId);
    if (!latest || latest.aborted) {
      return;
    }
    requestStates.delete(request.requestId);
    computeRequests.delete(request.requestId);

    if (error instanceof DOMException && error.name === 'AbortError') {
      postResponse({
        type: 'error',
        requestId: request.requestId,
        message: error.message || 'The operation was aborted',
        name: 'AbortError',
      });
      return;
    }

    postResponse({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
  }
}

const WARMUP_PROBE_SMALL_BP = 1_024;
const WARMUP_PROBE_LARGE_BP = 4_096;

function syntheticSequence(length: number): string {
  const unit = 'ACGT';
  let sequence = '';
  while (sequence.length < length) {
    sequence += unit;
  }
  return sequence.slice(0, length);
}

/**
 * Measure this model's cost per input base on the current device and record it, so
 * the zoom gate can size windows to the latency budget. Uses synthetic input:
 * inference time is content-independent, and this keeps warm-up off the network.
 * A throwaway run first absorbs one-time graph optimization before timing.
 */
async function handleWarmup(request: ComputationalWorkerWarmupRequest): Promise<void> {
  const { pack } = request;
  try {
    const { ort, session } = await getSession(pack.model.url);
    const inputName = pack.model.inputName ?? session.inputNames[0];
    if (!inputName) {
      throw new Error(`Computational model "${pack.name}" does not expose input names.`);
    }
    const warmupOutputSet = resolveComputationalWarmupOutputSet(pack);

    const timeRun = async (length: number): Promise<number> => {
      const encoded = encodeDnaOneHotNcl(syntheticSequence(length));
      const feeds: Record<string, InstanceType<OrtModule['Tensor']>> = {
        [inputName]: new ort.Tensor('float32', encoded, [1, 4, length]),
      };
      for (const [name, scalar] of Object.entries(pack.model.fixedInputs ?? {})) {
        feeds[name] = new ort.Tensor('float32', new Float32Array([scalar]), [1]);
      }
      const startedAt = performance.now();
      await session.run(feeds, [...warmupOutputSet.outputNames]);
      return performance.now() - startedAt;
    };

    await timeRun(WARMUP_PROBE_SMALL_BP);
    const smallMs = await timeRun(WARMUP_PROBE_SMALL_BP);
    const largeMs = await timeRun(WARMUP_PROBE_LARGE_BP);

    // Slope isolates per-base cost from fixed overhead; the average guards against a
    // noisy slope. Take the larger — a conservative cost yields a smaller, safer cap.
    const slope = (largeMs - smallMs) / (WARMUP_PROBE_LARGE_BP - WARMUP_PROBE_SMALL_BP);
    const average = largeMs / WARMUP_PROBE_LARGE_BP;
    const msPerBp = Math.max(1e-4, slope, average);

    recordInferenceCalibration(pack.model.url, msPerBp);
    postResponse({
      type: 'calibration',
      requestId: request.requestId,
      modelUrl: pack.model.url,
      msPerBp,
    });
  } catch (error: unknown) {
    postResponse({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
  }
}

/** Answer a hover from the mutant-curve cache; never computes. */
function handleMutants(request: ComputationalWorkerMutantsRequest): void {
  const { source, chr, position } = request;
  const mutagenesis = source.subtrack.mutagenesis;
  if (!mutagenesis) {
    postResponse({ type: 'mutants', requestId: request.requestId, overlay: null });
    return;
  }
  const scope = mutagenesisScope(
    source.pack,
    chr,
    source.reverseComplement === true,
    source.sequenceEdits,
    source.subtrack.outputName,
    mutagenesis.contextBp,
  );
  const record = mutantCurveCache.get(`${scope}|${position}`);
  postResponse({
    type: 'mutants',
    requestId: request.requestId,
    overlay: record ? mutantRecordToOverlay(record, position) : null,
  });
}

workerScope.onmessage = (event: MessageEvent<ComputationalWorkerRequest>) => {
  const request = event.data;
  if (!request) {
    return;
  }

  if (request.type === 'mutants') {
    handleMutants(request);
    return;
  }

  if (request.type === 'abort') {
    const state = requestStates.get(request.requestId);
    if (state) {
      state.aborted = true;
      requestStates.delete(request.requestId);
    }
    return;
  }

  if (request.type === 'warmup') {
    void handleWarmup(request);
    return;
  }

  requestStates.set(request.requestId, { aborted: false });
  void handleCompute(request);
};

export {};
