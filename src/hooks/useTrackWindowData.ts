import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildTrackWindowCacheKey, trackDataLoader } from '../data/trackDataLoader';
import { deriveComputationalNeighborSpecs, deriveTrackWindowSpec } from '../lib/trackWindowSpec';
import {
  getInferenceCostVersion,
  subscribeInferenceCost,
} from '../lib/computationalLimits';
import { deriveComputationalEligibility } from '../lib/computationalEligibility';
import type { DataWindowSpec, TrackSpec, TrackWindowData, ViewportState } from '../types';

type InternalState = {
  resolvedKey: string | null;
  resolvedChr: string | null;
  resolvedTrackId: string | null;
  error: string | null;
  data: TrackWindowData | null;
};

type HookResult = {
  loading: boolean;
  /**
   * The data returned belongs to a previous identity of this row (an older
   * window, or the sequence before the latest edit) and the current one is
   * still on its way. Drawn, but drawn as what it is.
   */
  stale: boolean;
  /**
   * The data is a run that has not finished: the bases it has scored so far.
   * Not stale -- it is this screen, just not all of it yet.
   */
  partial: boolean;
  error: string | null;
  data: TrackWindowData | null;
};

const COMPUTATIONAL_LOAD_DEBOUNCE_MS = 90;
const STANDARD_LOAD_DEBOUNCE_MS = 24;
const COMPUTATIONAL_ABORT_RETRY_DELAY_MS = 36;

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useTrackWindowData(track: TrackSpec, viewport: ViewportState, spec: DataWindowSpec): HookResult {
  const [state, setState] = useState<InternalState>({
    resolvedKey: null,
    resolvedChr: null,
    resolvedTrackId: null,
    error: null,
    data: null,
  });
  const [retryToken, setRetryToken] = useState(0);

  // Recompute the request window and the gate whenever this model's measured cost
  // changes (warm-up calibration, refinements): the budgeted cap feeds into both
  // `deriveTrackWindowSpec` and the gate, and if the window lagged the cap the hook
  // would keep fetching a stale window that no longer matches what the app expects.
  const inferenceCostVersion = useSyncExternalStore(
    subscribeInferenceCost,
    getInferenceCostVersion,
    getInferenceCostVersion,
  );

  const requestSpec = useMemo(
    () => deriveTrackWindowSpec(track, viewport, spec),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inferenceCostVersion drives the budgeted window size
    [inferenceCostVersion, spec, track, viewport],
  );
  const requestKey = requestSpec.key;
  const requestStart = requestSpec.requestStart;
  const requestEnd = requestSpec.requestEnd;
  const requestResolution = requestSpec.resolutionBp;
  // The focus (a mutagenesis row's bases on screen) rides along by its
  // primitives too, or rebuilding the spec here would silently drop it and the
  // worker would never be asked for the row.
  const focusStart = requestSpec.focus?.start;
  const focusEnd = requestSpec.focus?.end;
  const requestSpecStable = useMemo<DataWindowSpec>(
    () => ({
      key: requestKey,
      requestStart,
      requestEnd,
      resolutionBp: requestResolution,
      ...(focusStart !== undefined && focusEnd !== undefined ? { focus: { start: focusStart, end: focusEnd } } : {}),
    }),
    [focusEnd, focusStart, requestEnd, requestKey, requestResolution, requestStart],
  );
  // Computational features are already binned when they leave the worker, so
  // their resolved identity must include resolution even though the raw model
  // request window key intentionally stays stable across zoom-level changes.
  const resolvedRequestKey = track.source.type === 'computational'
    ? buildTrackWindowCacheKey(track, viewport.chr, requestSpecStable)
    : requestKey;

  const constraints = useMemo(() => {
    void inferenceCostVersion;
    if (track.source.type !== 'computational') {
      return { shouldLoad: true };
    }

    return {
      // The row's own eligibility: a mutagenesis row beyond its declared width
      // has nothing to compute and shows its hint instead of starting a run.
      shouldLoad: deriveComputationalEligibility(
        track.source.pack,
        viewport,
        requestSpecStable.resolutionBp,
        track.source.subtrack,
      ).eligible,
    };
  }, [
    inferenceCostVersion,
    requestSpecStable.resolutionBp,
    track.source,
    viewport,
  ]);
  // A mutagenesis run reports each batch of bases it finishes. Subscribing to
  // the loader is what turns those into a row that fills in rather than a row
  // that is empty for nine seconds and then complete.
  const subscribeToLoader = useCallback((listener: () => void) => trackDataLoader.subscribe(listener), []);
  const readPartialWindow = useCallback(
    () => trackDataLoader.peekPartialWindow(track, viewport.chr, requestSpecStable),
    [requestSpecStable, track, viewport.chr],
  );
  const partialWindow = useSyncExternalStore(subscribeToLoader, readPartialWindow, readPartialWindow);

  const prefetchedNeighborKeysRef = useRef(new Set<string>());
  const immediateCachedWindow = useMemo(
    () => (constraints.shouldLoad ? trackDataLoader.peekWindow(track, viewport.chr, requestSpecStable) : null),
    [constraints.shouldLoad, requestSpecStable, track, viewport.chr],
  );
  const hasInFlightWindow = useMemo(
    () => (constraints.shouldLoad ? trackDataLoader.hasInFlightWindow(track, viewport.chr, requestSpecStable) : false),
    [constraints.shouldLoad, requestSpecStable, track, viewport.chr],
  );

  useEffect(() => {
    if (!constraints.shouldLoad) {
      return;
    }

    // A cache hit is resolved synchronously during render (see `resolvedState`
    // below), so there is nothing to schedule here.
    if (immediateCachedWindow) {
      return;
    }

    const controller = new AbortController();
    let stale = false;
    const delayMs =
      track.source.type === 'computational' && hasInFlightWindow
        ? 0
        : track.source.type === 'computational'
          ? COMPUTATIONAL_LOAD_DEBOUNCE_MS
          : STANDARD_LOAD_DEBOUNCE_MS;
    const timeoutId = window.setTimeout(() => {
      if (stale) {
        return;
      }

      trackDataLoader
        .getWindow(track, viewport.chr, requestSpecStable, controller.signal)
        .then((data) => {
          if (stale) {
            return;
          }
          setState((previous) => {
            if (
              previous.resolvedKey === resolvedRequestKey &&
              previous.resolvedChr === viewport.chr &&
              previous.resolvedTrackId === track.id &&
              previous.error === null &&
              previous.data === data
            ) {
              return previous;
            }
            return {
              resolvedKey: resolvedRequestKey,
              resolvedChr: viewport.chr,
              resolvedTrackId: track.id,
              error: null,
              data,
            };
          });
        })
        .catch((error: unknown) => {
          if (stale) {
            return;
          }
          if (isAbortError(error)) {
            if (controller.signal.aborted) {
              return;
            }
            window.setTimeout(() => {
              if (!stale) {
                setRetryToken((previous) => previous + 1);
              }
            }, COMPUTATIONAL_ABORT_RETRY_DELAY_MS);
            return;
          }

          const nextError = error instanceof Error ? error.message : 'Unknown error while fetching track data';
          setState((previous) => {
            if (
              previous.resolvedKey === resolvedRequestKey &&
              previous.resolvedChr === viewport.chr &&
              previous.resolvedTrackId === track.id &&
              previous.error === nextError &&
              previous.data === null
            ) {
              return previous;
            }
            return {
              resolvedKey: resolvedRequestKey,
              resolvedChr: viewport.chr,
              resolvedTrackId: track.id,
              error: nextError,
              data: null,
            };
          });
        });
    }, delayMs);

    return () => {
      stale = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    constraints.shouldLoad,
    hasInFlightWindow,
    immediateCachedWindow,
    requestSpecStable,
    resolvedRequestKey,
    retryToken,
    track,
    viewport.chr,
  ]);

  useEffect(() => {
    if (track.source.type !== 'computational' || !constraints.shouldLoad) {
      return;
    }

    // Prefetch each mounted display track. Raw model work still coalesces by
    // output collection in the worker, while every selected child gets its own
    // post-binned cache. This matters for an individually selected attribution:
    // its group's first manifest output may be hidden and cannot act as leader.
    if (state.resolvedKey !== resolvedRequestKey || state.error || !state.data) {
      return;
    }

    const neighborSpecs = deriveComputationalNeighborSpecs(track, viewport, requestSpecStable);
    for (const neighborSpec of neighborSpecs) {
      const prefetchKey = `${track.id}|${buildTrackWindowCacheKey(track, viewport.chr, neighborSpec)}`;
      if (prefetchedNeighborKeysRef.current.has(prefetchKey)) {
        continue;
      }
      prefetchedNeighborKeysRef.current.add(prefetchKey);
      trackDataLoader.prefetch(track, viewport.chr, neighborSpec);
    }
  }, [
    requestSpecStable,
    resolvedRequestKey,
    state.data,
    state.error,
    state.resolvedKey,
    track,
    viewport,
    constraints.shouldLoad,
  ]);

  useEffect(() => {
    prefetchedNeighborKeysRef.current.clear();
  }, [track.id, viewport.chr]);

  // A synchronous cache hit resolves the window during render; only misses need
  // to go through `state`, which keeps setState out of the effect above.
  const resolvedState = useMemo<InternalState>(
    () =>
      immediateCachedWindow
        ? {
            resolvedKey: resolvedRequestKey,
            resolvedChr: viewport.chr,
            resolvedTrackId: track.id,
            error: null,
            data: immediateCachedWindow,
          }
        : state,
    [immediateCachedWindow, resolvedRequestKey, state, track.id, viewport.chr],
  );


  const isResolved =
    resolvedState.resolvedKey === resolvedRequestKey &&
    resolvedState.resolvedChr === viewport.chr &&
    resolvedState.resolvedTrackId === track.id;

  // While a new window loads, keep drawing the most recently resolved window for
  // this track/chromosome instead of blanking the row. Features carry absolute
  // genomic coordinates, so an older window still draws in the right place; it
  // may just not span the whole viewport until the new one lands. But it is
  // still the OLD answer: the row is told so (`loading`, `stale`) and draws it
  // ghosted. Reporting it as settled hid a multi-second ISM recompute behind
  // the previous screen's letters, which read as the row not updating at all.
  const staleData =
    state.resolvedChr === viewport.chr && state.resolvedTrackId === track.id ? state.data : null;
  const current = isResolved || immediateCachedWindow !== null;
  // What this screen has so far beats what the last screen had.
  const livePartial = !current && constraints.shouldLoad ? partialWindow : null;
  const fallbackData = immediateCachedWindow ?? livePartial ?? staleData;

  return {
    loading: constraints.shouldLoad ? !current : false,
    stale: constraints.shouldLoad ? !current && livePartial === null && staleData !== null : false,
    partial: livePartial !== null,
    error: isResolved ? resolvedState.error : null,
    data: constraints.shouldLoad ? (isResolved ? resolvedState.data : fallbackData) : null,
  };
}
