import { getReader } from './bbiReader';

/**
 * Transcript ids of the MANE Select set, per window.
 *
 * GENCODE's bigGenePred carries no flag for which transcript represents a gene,
 * so the representative set comes from UCSC's companion MANE track and is
 * matched back by versioned Ensembl transcript id. One row per gene makes this
 * a small read next to the annotation itself.
 */

/** Requests snap to this grid so panning re-uses one cached window. */
const MANE_WINDOW_GRID_BP = 250_000;

const windowCache = new Map<string, Promise<Set<string>>>();
const MAX_CACHE_ENTRIES = 64;

function cacheSet(key: string, value: Promise<Set<string>>): void {
  windowCache.set(key, value);
  while (windowCache.size > MAX_CACHE_ENTRIES) {
    const oldest = windowCache.keys().next().value;
    if (!oldest) {
      return;
    }
    windowCache.delete(oldest);
  }
}

export type ManeWindowParams = {
  url: string;
  chr: string;
  start: number;
  end: number;
};

export async function fetchManeTranscriptIds({
  url,
  chr,
  start,
  end,
}: ManeWindowParams): Promise<Set<string>> {
  const windowStart = Math.max(0, Math.floor(start / MANE_WINDOW_GRID_BP) * MANE_WINDOW_GRID_BP);
  const windowEnd = Math.ceil(end / MANE_WINDOW_GRID_BP) * MANE_WINDOW_GRID_BP;
  const key = `${url}|${chr}|${windowStart}|${windowEnd}`;

  const cached = windowCache.get(key);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const reader = getReader(url);
    const rows = await reader.readBigBedData(chr, windowStart, chr, windowEnd);
    const ids = new Set<string>();
    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (name.length > 0) {
        ids.add(name);
      }
    }
    return ids;
  })().catch(() => {
    // A missing companion track must not take the annotation down with it: the
    // transcripts still draw, just without a representative one singled out.
    windowCache.delete(key);
    return new Set<string>();
  });

  cacheSet(key, request);
  return request;
}

/** Test seam: the window cache is module-level and would leak between cases. */
export function clearManeCache(): void {
  windowCache.clear();
}
