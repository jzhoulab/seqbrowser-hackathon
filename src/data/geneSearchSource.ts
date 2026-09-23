import { rankGeneMatches, type GeneMatch, type UcscSearchPayload } from '../features/search/geneMatches';

export type { GeneMatch };

const UCSC_SEARCH_ENDPOINT = 'https://api.genome.ucsc.edu/search';

/**
 * A UCSC symbol query costs 200-540 KB and 2-4 s, so every answer is memoized
 * for the session: retyping a symbol, or backspacing back onto one, resolves
 * without touching the network.
 */
const searchCache = new Map<string, Promise<GeneMatch[]>>();
const MAX_SEARCH_CACHE_ENTRIES = 120;

function cacheKey(genome: string, term: string): string {
  return `${genome} ${term.trim().toUpperCase()}`;
}

function cacheSet(key: string, value: Promise<GeneMatch[]>): void {
  searchCache.set(key, value);
  while (searchCache.size > MAX_SEARCH_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (!oldest) {
      return;
    }
    searchCache.delete(oldest);
  }
}

function buildSearchUrl(genome: string, term: string): string {
  // UCSC separates query parameters with `;`, not `&`.
  return `${UCSC_SEARCH_ENDPOINT}?search=${encodeURIComponent(term)};genome=${encodeURIComponent(genome)}`;
}

export type GeneSearchParams = {
  genome: string;
  term: string;
  isKnownChromosome?: (chr: string) => boolean;
  limit?: number;
  signal?: AbortSignal;
};

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Resolve a gene symbol to candidate loci through UCSC's search endpoint.
 *
 * Aborting only detaches this caller: the in-flight request stays alive and
 * fills the cache, because a user who types `TP5`, pauses, then finishes `TP53`
 * would otherwise pay for the same 3-second round trip twice.
 */
export async function searchGenes({
  genome,
  term,
  isKnownChromosome,
  limit,
  signal,
}: GeneSearchParams): Promise<GeneMatch[]> {
  const trimmed = term.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const key = cacheKey(genome, trimmed);
  let request = searchCache.get(key);

  if (!request) {
    request = fetch(buildSearchUrl(genome, trimmed))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`UCSC search failed with ${response.status}`);
        }
        return (await response.json()) as UcscSearchPayload;
      })
      .then((payload) => rankGeneMatches(payload, trimmed, { isKnownChromosome, limit }))
      .catch((error: unknown) => {
        // A failed lookup must not poison the cache -- the next keystroke retries.
        searchCache.delete(key);
        throw error;
      });
    cacheSet(key, request);
  }

  if (!signal) {
    return request;
  }
  if (signal.aborted) {
    throw createAbortError();
  }

  return new Promise<GeneMatch[]>((resolve, reject) => {
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
      (matches) => finish(() => resolve(matches)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Test seam: the cache is module-level and would otherwise leak between cases. */
export function clearGeneSearchCache(): void {
  searchCache.clear();
}
