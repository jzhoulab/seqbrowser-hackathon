import { useEffect, useMemo, useState } from 'react';
import {
  fetchGenomeSequenceWindow,
  type GenomeSequenceWindow,
} from '../data/sequenceDataSource';
import { clamp } from '../lib/genomeMath';

type UseReferenceSequenceWindowArgs = {
  genome: string;
  chr: string;
  chrLength: number;
  start: number;
  end: number;
  enabled?: boolean;
  bufferMultiplier?: number;
  minBufferBp?: number;
  minStrideBp?: number;
};

export type ReferenceSequenceWindowResult = GenomeSequenceWindow & {
  loading: boolean;
  error: string | null;
};

type LoadedSequenceState = GenomeSequenceWindow & {
  genome: string;
  chr: string;
  resolvedKey: string;
  error: string | null;
};

const DEFAULT_BUFFER_MULTIPLIER = 3;
const DEFAULT_MIN_BUFFER_BP = 840;
const DEFAULT_MIN_STRIDE_BP = 48;

const EMPTY_RESULT: ReferenceSequenceWindowResult = {
  sequence: '',
  start: 0,
  end: 0,
  loading: false,
  error: null,
};

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useReferenceSequenceWindow({
  genome,
  chr,
  chrLength,
  start,
  end,
  enabled = true,
  bufferMultiplier = DEFAULT_BUFFER_MULTIPLIER,
  minBufferBp = DEFAULT_MIN_BUFFER_BP,
  minStrideBp = DEFAULT_MIN_STRIDE_BP,
}: UseReferenceSequenceWindowArgs): ReferenceSequenceWindowResult {
  const [state, setState] = useState<LoadedSequenceState | null>(null);
  const visibleStart = clamp(Math.round(start), 0, Math.max(0, chrLength - 1));
  const visibleEnd = clamp(Math.round(end), visibleStart + 1, chrLength);
  const spanBp = Math.max(1, visibleEnd - visibleStart);

  const requestWindow = useMemo(() => {
    const bufferSpanBp = Math.min(
      chrLength,
      Math.max(spanBp * Math.max(1, bufferMultiplier), Math.max(1, Math.floor(minBufferBp))),
    );
    const bufferStrideBp = Math.max(Math.floor(minStrideBp), Math.floor(spanBp * 0.4), 1);
    const maxBufferStart = Math.max(0, chrLength - bufferSpanBp);
    const provisionalStart = visibleStart - Math.floor((bufferSpanBp - spanBp) * 0.5);
    const alignedStart = Math.floor(provisionalStart / bufferStrideBp) * bufferStrideBp;
    const requestStart = clamp(alignedStart, 0, maxBufferStart);
    const requestEnd = Math.min(chrLength, requestStart + bufferSpanBp);

    return {
      start: requestStart,
      end: requestEnd,
      key: `${genome}|${chr}|${requestStart}:${requestEnd}`,
    };
  }, [bufferMultiplier, chr, chrLength, genome, minBufferBp, minStrideBp, spanBp, visibleStart]);

  const hasCoverage =
    enabled &&
    state !== null &&
    state.genome === genome &&
    state.chr === chr &&
    state.sequence.length > 0 &&
    state.start <= visibleStart &&
    state.end >= visibleEnd;
  const requestResolved =
    state?.genome === genome && state.chr === chr && state.resolvedKey === requestWindow.key;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    let stale = false;

    void fetchGenomeSequenceWindow({
      genome,
      chr,
      start: requestWindow.start,
      end: requestWindow.end,
      signal: controller.signal,
    })
      .then((result) => {
        if (stale) {
          return;
        }
        setState({
          ...result,
          sequence: result.sequence.toUpperCase(),
          genome,
          chr,
          resolvedKey: requestWindow.key,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (stale || isAbortError(error)) {
          return;
        }
        setState((previous) => {
          const retained = previous?.genome === genome && previous.chr === chr && previous.sequence.length > 0
            ? previous
            : null;
          return {
            sequence: retained?.sequence ?? '',
            start: retained?.start ?? 0,
            end: retained?.end ?? 0,
            genome,
            chr,
            resolvedKey: requestWindow.key,
            error: error instanceof Error ? error.message : 'Failed to load sequence',
          };
        });
      });

    return () => {
      stale = true;
      // This only stops this hook from observing the shared request; the data-layer
      // request remains alive for other consumers and future covering-window hits.
      controller.abort();
    };
  }, [
    chr,
    enabled,
    genome,
    requestWindow.end,
    requestWindow.key,
    requestWindow.start,
  ]);

  if (!enabled) {
    return EMPTY_RESULT;
  }
  if (hasCoverage && state) {
    return {
      sequence: state.sequence,
      start: state.start,
      end: state.end,
      loading: false,
      error: null,
    };
  }

  return {
    sequence: '',
    start: 0,
    end: 0,
    loading: !requestResolved,
    error: requestResolved ? state?.error ?? null : null,
  };
}
