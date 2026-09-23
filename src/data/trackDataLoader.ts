import { clampRangeToChromosome, niceStep, toRange } from '../lib/genomeMath';
import type { DataWindowSpec, TrackFeature, TrackSpec, TrackWindowData } from '../types';
import { fetchTrackWindow, getTrackResolutionTag, trackSourceKey } from './bbiDataSource';

type CacheValue = TrackWindowData;

const MAX_CACHE_ENTRIES = 800;

function computationalResolutionTag(resolutionBp: number): string {
  const floored = Math.floor(resolutionBp);
  const normalized = Number.isFinite(floored) ? Math.max(1, floored) : 1;
  return `comp:r${normalized}`;
}

export function parseTrackWindowCacheKey(
  key: string,
): { prefix: string; requestStart: number; requestEnd: number; tag: string } | null {
  const segments = key.split('|');
  if (segments.length < 4) {
    return null;
  }

  const locus = segments[2] ?? '';
  const firstColon = locus.indexOf(':');
  if (firstColon <= 0) {
    return null;
  }

  const chr = locus.slice(0, firstColon);
  const coords = locus.slice(firstColon + 1).split(':');
  if (coords.length < 2) {
    return null;
  }

  const requestStart = Number(coords[0]);
  const requestEnd = Number(coords[1]);
  if (!Number.isFinite(requestStart) || !Number.isFinite(requestEnd)) {
    return null;
  }

  return {
    prefix: `${segments[0]}|${segments[1]}|${chr}`,
    requestStart,
    requestEnd,
    tag: segments[3] ?? '',
  };
}

function buildWindowSpec(
  chr: string,
  chrLength: number,
  centerBp: number,
  bpPerPx: number,
  widthPx: number,
  resolutionScale = 2.4,
): DataWindowSpec {
  const viewport = clampRangeToChromosome(toRange(centerBp, bpPerPx, widthPx), chrLength);
  const targetSpan = Math.max(viewport.span * 2.5, bpPerPx * widthPx);
  const spanStep = niceStep(targetSpan);
  const requestStart = Math.max(0, Math.floor((viewport.start - viewport.span * 0.75) / spanStep) * spanStep);
  const requestEnd = Math.min(chrLength, requestStart + spanStep * 2);
  const normalizedResolutionScale = Number.isFinite(resolutionScale)
    ? Math.max(0.1, resolutionScale)
    : 2.4;
  const resolutionBp = Math.max(1, niceStep(bpPerPx * normalizedResolutionScale));

  return {
    key: `${chr}:${requestStart}:${requestEnd}:r${resolutionBp}`,
    requestStart,
    requestEnd,
    resolutionBp,
  };
}

class TrackDataLoader {
  private readonly cache = new Map<string, CacheValue>();
  private readonly inFlight = new Map<string, Promise<CacheValue>>();
  /**
   * What an in-flight window has computed so far. A mutagenesis run takes
   * seconds and reports each batch of bases; the row draws them rather than
   * waiting for the screen to be finished. Never cached: the result replaces it.
   */
  private readonly partials = new Map<string, CacheValue>();
  private readonly listeners = new Set<() => void>();
  private emitScheduled = false;

  static buildSpec = buildWindowSpec;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private scheduleEmitChange(): void {
    if (this.emitScheduled) {
      return;
    }
    this.emitScheduled = true;

    const flush = () => {
      this.emitScheduled = false;
      this.emitChange();
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(flush);
      return;
    }

    setTimeout(flush, 0);
  }

  private buildKey(track: TrackSpec, chr: string, spec: DataWindowSpec): string {
    return buildTrackWindowCacheKey(track, chr, spec);
  }

  private buildTrackChrPrefix(track: TrackSpec, chr: string): string {
    return `${trackSourceKey(track)}|${track.kind}|${chr}`;
  }

  private findCoveringCachedComputationalWindow(
    track: TrackSpec,
    chr: string,
    spec: DataWindowSpec,
  ): { key: string; value: CacheValue } | null {
    const prefix = this.buildTrackChrPrefix(track, chr);
    const requiredTag = computationalResolutionTag(spec.resolutionBp);
    let bestMatch: { key: string; value: CacheValue; span: number } | null = null;

    for (const [key, value] of this.cache.entries()) {
      const parsed = parseTrackWindowCacheKey(key);
      if (!parsed || parsed.prefix !== prefix || parsed.tag !== requiredTag) {
        continue;
      }
      if (parsed.requestStart > spec.requestStart || parsed.requestEnd < spec.requestEnd) {
        continue;
      }

      const span = parsed.requestEnd - parsed.requestStart;
      if (!bestMatch || span < bestMatch.span) {
        bestMatch = { key, value, span };
      }
    }

    if (!bestMatch) {
      return null;
    }
    return { key: bestMatch.key, value: bestMatch.value };
  }

  private findCoveringInFlightComputationalWindow(
    track: TrackSpec,
    chr: string,
    spec: DataWindowSpec,
  ): Promise<CacheValue> | null {
    const prefix = this.buildTrackChrPrefix(track, chr);
    const requiredTag = computationalResolutionTag(spec.resolutionBp);
    let bestMatch: { request: Promise<CacheValue>; span: number } | null = null;

    for (const [key, request] of this.inFlight.entries()) {
      const parsed = parseTrackWindowCacheKey(key);
      if (!parsed || parsed.prefix !== prefix || parsed.tag !== requiredTag) {
        continue;
      }
      if (parsed.requestStart > spec.requestStart || parsed.requestEnd < spec.requestEnd) {
        continue;
      }

      const span = parsed.requestEnd - parsed.requestStart;
      if (!bestMatch || span < bestMatch.span) {
        bestMatch = { request, span };
      }
    }

    return bestMatch?.request ?? null;
  }

  private touch(key: string, value: CacheValue): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);

    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (!firstKey) {
        return;
      }
      this.cache.delete(firstKey);
    }
  }

  /** What this window has computed so far, if it is still running. */
  peekPartialWindow(track: TrackSpec, chr: string, spec: DataWindowSpec): CacheValue | null {
    return this.partials.get(this.buildKey(track, chr, spec)) ?? null;
  }

  peekWindow(track: TrackSpec, chr: string, spec: DataWindowSpec): CacheValue | null {
    const key = this.buildKey(track, chr, spec);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    // A focused window (a mutagenesis row) is only complete for the bases it
    // focused on; a wider window that covers the range did not do this work.
    if (track.source.type !== 'computational' || spec.focus) {
      return null;
    }

    return this.findCoveringCachedComputationalWindow(track, chr, spec)?.value ?? null;
  }

  hasInFlightWindow(track: TrackSpec, chr: string, spec: DataWindowSpec): boolean {
    const key = this.buildKey(track, chr, spec);
    if (this.inFlight.has(key)) {
      return true;
    }

    if (track.source.type !== 'computational' || spec.focus) {
      return false;
    }

    return this.findCoveringInFlightComputationalWindow(track, chr, spec) !== null;
  }

  getWindow(
    track: TrackSpec,
    chr: string,
    spec: DataWindowSpec,
    signal?: AbortSignal,
  ): Promise<CacheValue> {
    const key = this.buildKey(track, chr, spec);

    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key, cached);
      return Promise.resolve(cached);
    }

    const existingRequest = this.inFlight.get(key);
    if (existingRequest) {
      return existingRequest;
    }

    // A focused window (a mutagenesis row) is only complete for the bases it
    // focused on; a wider cached window that covers the range does not cover
    // the work, so it is never substituted.
    if (track.source.type === 'computational' && !spec.focus) {
      const coveringCached = this.findCoveringCachedComputationalWindow(track, chr, spec);
      if (coveringCached) {
        this.touch(coveringCached.key, coveringCached.value);
        return Promise.resolve(coveringCached.value);
      }

      const coveringInFlight = this.findCoveringInFlightComputationalWindow(track, chr, spec);
      if (coveringInFlight) {
        return coveringInFlight;
      }
    }

    const fetched = track.source.type === 'group'
      ? this.fetchGroupWindow(track.source.members, chr, spec, signal)
      : fetchTrackWindow(track, chr, spec, signal, (features) => {
          this.partials.set(key, { spec, features, fetchedAt: Date.now() });
          this.scheduleEmitChange();
        });
    const request = fetched
      .then((features) => {
        const value: CacheValue = {
          spec,
          features,
          fetchedAt: Date.now(),
        };
        this.touch(key, value);
        this.inFlight.delete(key);
        this.partials.delete(key);
        this.scheduleEmitChange();
        return value;
      })
      .catch((error) => {
        this.inFlight.delete(key);
        this.partials.delete(key);
        this.scheduleEmitChange();
        throw error;
      });

    this.inFlight.set(key, request);
    this.scheduleEmitChange();
    return request;
  }

  /**
   * A combined plot's window is its members' windows, each fetched through this
   * cache under the member's own key: a member shown on its own elsewhere shares
   * the data, and the model rail, which reads member keys, sees it computed.
   */
  private async fetchGroupWindow(
    members: readonly TrackSpec[],
    chr: string,
    spec: DataWindowSpec,
    signal?: AbortSignal,
  ): Promise<TrackFeature[]> {
    const windows = await Promise.all(members.map((member) => this.getWindow(member, chr, spec, signal)));
    return windows.flatMap((window, seriesIndex) =>
      window.features.map((feature) => ({ ...feature, seriesIndex })),
    );
  }

  prefetch(track: TrackSpec, chr: string, spec: DataWindowSpec): void {
    this.getWindow(track, chr, spec).catch(() => {
      // Prefetch failures are intentionally ignored.
    });
  }
}

export const trackDataLoader = new TrackDataLoader();
export const deriveWindowSpec = TrackDataLoader.buildSpec;

export function buildTrackWindowCacheKey(track: TrackSpec, chr: string, spec: DataWindowSpec): string {
  if (track.source.type === 'computational') {
    // A focused window (a mutagenesis row's bases on screen) is its own entry:
    // the same request window with another focus is other work. The focus goes
    // in the tag so a focused entry never reads as covering for anything else.
    const focus = spec.focus ? `:ism${spec.focus.start}-${spec.focus.end}` : '';
    return `${trackSourceKey(track)}|${track.kind}|${chr}:${spec.requestStart}:${spec.requestEnd}|${computationalResolutionTag(spec.resolutionBp)}${focus}`;
  }

  const resolutionTag = getTrackResolutionTag(track, spec.resolutionBp) ?? `r${spec.resolutionBp}`;
  return `${trackSourceKey(track)}|${track.kind}|${chr}:${spec.requestStart}:${spec.requestEnd}|${resolutionTag}`;
}
