import { createGeneIndex, type GeneEntry, type GeneIndex } from '../features/search/geneIndex';

/**
 * The gene table shipped with the app, loaded once on demand.
 *
 * A UCSC symbol query costs 200-540 KB and two to four seconds. This file is
 * 220 KB gzipped for the whole of hg38 and is fetched once, after which a symbol
 * resolves locally with no round trip at all. Genes it does not carry -- most
 * pseudogenes and lncRNAs -- fall through to UCSC, so the tail still works.
 *
 * Built by `scripts/build-gene-index.mjs`.
 */

export type LocalGeneIndex = {
  index: GeneIndex;
  genome: string;
  size: number;
};

const indexCache = new Map<string, Promise<LocalGeneIndex | null>>();

function indexUrl(genome: string): string {
  return `/data/genes/${encodeURIComponent(genome)}.genes.tsv`;
}

/** `symbol \t chr \t start \t length [\t strand]`, one gene per line, `#` for the header. */
export function parseGeneTable(text: string): GeneEntry[] {
  const entries: GeneEntry[] = [];

  for (const line of text.split('\n')) {
    if (line.length === 0 || line.charCodeAt(0) === 35) {
      continue;
    }
    const [symbol, chr, startText, lengthText, strandText] = line.split('\t');
    if (!symbol || !chr) {
      continue;
    }
    const start = Number(startText);
    const length = Number(lengthText);
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
      continue;
    }
    entries.push({
      symbol,
      chr,
      start,
      end: start + length,
      ...(strandText === '+' || strandText === '-' ? { strand: strandText } : {}),
    });
  }

  return entries;
}

export async function loadLocalGeneIndex(genome: string): Promise<LocalGeneIndex | null> {
  const cached = indexCache.get(genome);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const response = await fetch(indexUrl(genome));
    if (!response.ok) {
      // No table for this assembly: the caller falls back to UCSC. Cached as a
      // miss so a search per keystroke does not become a 404 per keystroke.
      return null;
    }
    const entries = parseGeneTable(await response.text());
    if (entries.length === 0) {
      return null;
    }
    return { index: createGeneIndex(entries), genome, size: entries.length };
  })().catch(() => null);

  indexCache.set(genome, request);
  return request;
}

/** Test seam: the cache is module-level and would leak between cases. */
export function clearLocalGeneIndexCache(): void {
  indexCache.clear();
}
