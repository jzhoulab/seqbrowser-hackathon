import {
  clamp,
  formatLocus,
} from '../lib/genomeMath';
import { timedFetch } from './timedFetch';

export type GenomeSequenceWindow = {
  sequence: string;
  start: number;
  end: number;
};

type SequenceCacheEntry = {
  genome: string;
  chr: string;
  start: number;
  end: number;
  request: Promise<GenomeSequenceWindow>;
};

const sequenceCache = new Map<string, SequenceCacheEntry>();
const MAX_SEQUENCE_CACHE_ENTRIES = 240;

function cacheSet(key: string, value: SequenceCacheEntry): void {
  if (sequenceCache.has(key)) {
    sequenceCache.delete(key);
  }
  sequenceCache.set(key, value);

  while (sequenceCache.size > MAX_SEQUENCE_CACHE_ENTRIES) {
    const firstKey = sequenceCache.keys().next().value;
    if (!firstKey) {
      return;
    }
    sequenceCache.delete(firstKey);
  }
}

function buildUCSCSequenceUrl(genome: string, chr: string, start: number, end: number): string {
  return `https://api.genome.ucsc.edu/getData/sequence?genome=${encodeURIComponent(genome)};chrom=${encodeURIComponent(
    chr,
  )};start=${start};end=${end}`;
}

type SequenceParams = {
  genome: string;
  chr: string;
  start: number;
  end: number;
  signal?: AbortSignal;
};

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function observeRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return request;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(createAbortError()));

    signal.addEventListener('abort', handleAbort, { once: true });
    request.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function findCoveringEntry(
  genome: string,
  chr: string,
  start: number,
  end: number,
): [string, SequenceCacheEntry] | null {
  let best: [string, SequenceCacheEntry] | null = null;

  for (const candidate of sequenceCache.entries()) {
    const entry = candidate[1];
    if (entry.genome !== genome || entry.chr !== chr || entry.start > start || entry.end < end) {
      continue;
    }
    if (!best || entry.end - entry.start < best[1].end - best[1].start) {
      best = candidate;
    }
  }

  if (best) {
    // Touch covering hits so an actively reused buffer is not the first LRU entry evicted.
    sequenceCache.delete(best[0]);
    sequenceCache.set(best[0], best[1]);
  }
  return best;
}

async function requestGenomeSequenceWindow({
  genome,
  chr,
  start,
  end,
  signal,
}: SequenceParams): Promise<GenomeSequenceWindow> {
  const boundedStart = Math.max(0, Math.floor(start));
  const boundedEnd = Math.max(boundedStart + 1, Math.floor(end));
  if (signal?.aborted) {
    throw createAbortError();
  }

  const cached = findCoveringEntry(genome, chr, boundedStart, boundedEnd);
  let entry = cached?.[1];

  if (!entry) {
    const key = `${genome}|${chr}|${boundedStart}|${boundedEnd}`;
    const request = (async (): Promise<GenomeSequenceWindow> => {
      // The cache owns this request. Individual callers can stop observing it, but
      // must not cancel a request that another mounted track may still need.
      // It can still time out: a stalled UCSC response used to sit in this cache
      // forever, and every later window joined the dead promise.
      const response = await timedFetch(buildUCSCSequenceUrl(genome, chr, boundedStart, boundedEnd));
      if (!response.ok) {
        throw new Error(`Sequence request failed (${response.status}) for ${genome}:${chr}:${boundedStart}-${boundedEnd}`);
      }

      const payload = (await response.json()) as { dna?: string };
      const dna = typeof payload.dna === 'string' ? payload.dna : '';
      if (dna.length === 0) {
        throw new Error(`No sequence returned for ${genome}:${chr}:${boundedStart}-${boundedEnd}`);
      }
      if (dna.length !== boundedEnd - boundedStart) {
        throw new Error(`Incomplete sequence returned for ${genome}:${chr}:${boundedStart}-${boundedEnd}`);
      }

      return {
        sequence: dna,
        start: boundedStart,
        end: boundedEnd,
      };
    })();

    entry = {
      genome,
      chr,
      start: boundedStart,
      end: boundedEnd,
      request,
    };
    cacheSet(key, entry);
    void request.catch(() => {
      if (sequenceCache.get(key) === entry) {
        sequenceCache.delete(key);
      }
    });
  }

  const window = await observeRequest(entry.request, signal);
  const sliceStart = boundedStart - window.start;
  const sliceEnd = boundedEnd - window.start;
  const sequence = window.sequence.slice(sliceStart, sliceEnd);
  if (sequence.length !== boundedEnd - boundedStart) {
    throw new Error(`Incomplete sequence returned for ${genome}:${chr}:${boundedStart}-${boundedEnd}`);
  }

  return { sequence, start: boundedStart, end: boundedEnd };
}

export async function fetchGenomeSequenceWindow(params: SequenceParams): Promise<GenomeSequenceWindow> {
  return requestGenomeSequenceWindow(params);
}

export async function fetchGenomeSequence(params: SequenceParams): Promise<string> {
  const result = await requestGenomeSequenceWindow(params);
  return result.sequence;
}

export type SequencePreviewResult = {
  sequence: string;
  start: number;
  end: number;
};

export async function fetchSequencePreview(
  genome: string,
  chr: string,
  viewStart: number,
  viewEnd: number,
  maxBp = 220,
  signal?: AbortSignal,
): Promise<SequencePreviewResult> {
  const span = Math.max(1, Math.floor(viewEnd) - Math.floor(viewStart));
  if (span <= maxBp) {
    const sequence = await fetchGenomeSequence({
      genome,
      chr,
      start: viewStart,
      end: viewEnd,
      signal,
    });

    return {
      sequence,
      start: Math.max(0, Math.floor(viewStart)),
      end: Math.max(Math.floor(viewStart) + 1, Math.floor(viewEnd)),
    };
  }

  const center = (viewStart + viewEnd) * 0.5;
  const half = Math.floor(maxBp * 0.5);
  const start = Math.max(0, Math.floor(center) - half);
  const end = start + maxBp;
  const sequence = await fetchGenomeSequence({
    genome,
    chr,
    start,
    end,
    signal,
  });

  return {
    sequence,
    start,
    end,
  };
}

export function normalizeBase(base: string): string {
  const upper = base.toUpperCase();
  if (upper === 'A' || upper === 'C' || upper === 'G' || upper === 'T') {
    return upper;
  }
  return 'N';
}

export function encodeDnaOneHotNcl(sequence: string): Float32Array {
  const seqLength = sequence.length;
  const encoded = new Float32Array(4 * seqLength);

  for (let index = 0; index < seqLength; index += 1) {
    const base = normalizeBase(sequence[index] ?? 'N');
    const offset = index;
    if (base === 'A') {
      encoded[offset] = 1;
      continue;
    }
    if (base === 'C') {
      encoded[seqLength + offset] = 1;
      continue;
    }
    if (base === 'G') {
      encoded[seqLength * 2 + offset] = 1;
      continue;
    }
    if (base === 'T') {
      encoded[seqLength * 3 + offset] = 1;
    }
  }

  return encoded;
}

export function sequenceCoordinateLabel(chr: string, start: number, end: number): string {
  const boundedStart = clamp(Math.round(start), 0, Number.MAX_SAFE_INTEGER);
  const boundedEnd = clamp(Math.round(end), boundedStart + 1, Number.MAX_SAFE_INTEGER);
  return formatLocus(chr, boundedStart, boundedEnd);
}
