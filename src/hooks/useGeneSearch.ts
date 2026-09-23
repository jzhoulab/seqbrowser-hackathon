import { useEffect, useMemo, useState } from 'react';
import { searchGenes, type GeneMatch } from '../data/geneSearchSource';
import { loadLocalGeneIndex, type LocalGeneIndex } from '../data/localGeneIndex';

export type GeneSearchStatus = 'idle' | 'searching' | 'ready' | 'error';

export type GeneSearchState = {
  matches: readonly GeneMatch[];
  status: GeneSearchStatus;
};

const IDLE: GeneSearchState = { matches: [], status: 'idle' };

/** Shortest symbol worth a round trip. `TP` already costs ~300 KB at UCSC. */
const MIN_TERM_LENGTH = 2;
const DEBOUNCE_MS = 300;
const LOCAL_MATCH_LIMIT = 8;

/** Rank the shipped table the way the UCSC answers are ranked: exact, then prefix. */
function searchLocalIndex(
  local: LocalGeneIndex,
  term: string,
  isKnownChromosome?: (chr: string) => boolean,
): GeneMatch[] {
  const exact = local.index.findExact(term);
  const prefix = local.index.findPrefix(term);
  const ordered = exact ? [exact, ...prefix.filter((gene) => gene !== exact)] : prefix;

  return ordered
    .filter((gene) => !isKnownChromosome || isKnownChromosome(gene.chr))
    .slice(0, LOCAL_MATCH_LIMIT)
    .map((gene) => ({
      symbol: gene.symbol,
      chr: gene.chr,
      start: gene.start,
      end: gene.end,
      source: 'refseq-select',
      ...(gene.strand ? { strand: gene.strand } : {}),
    }));
}

/** Answers are kept with the term that produced them, so a stale list is never shown. */
type ResolvedSearch = {
  term: string;
  matches: readonly GeneMatch[];
  status: 'ready' | 'error';
};

export type UseGeneSearchParams = {
  genome: string;
  term: string;
  /** Set false while the term is already a locus, or the box is closed. */
  enabled: boolean;
  isKnownChromosome?: (chr: string) => boolean;
};

/**
 * Debounced gene-symbol lookup for the locus box.
 *
 * Typing is far faster than UCSC answers, so each keystroke restarts a 300 ms
 * timer and aborts the previous wait. `searching` is derived rather than stored:
 * any term without a matching resolved answer is, by definition, still in
 * flight, which keeps the dropdown from flickering through a stale list.
 */
export function useGeneSearch({
  genome,
  term,
  enabled,
  isKnownChromosome,
}: UseGeneSearchParams): GeneSearchState {
  const [resolved, setResolved] = useState<ResolvedSearch | null>(null);
  const [local, setLocal] = useState<LocalGeneIndex | null>(null);
  const trimmed = term.trim();
  const active = enabled && trimmed.length >= MIN_TERM_LENGTH;

  // One fetch per assembly, the first time a search is made against it.
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    void loadLocalGeneIndex(genome).then((loaded) => {
      if (!cancelled) {
        setLocal(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, genome]);

  // A hit in the shipped table answers immediately: no debounce, no request.
  const localMatches = useMemo(() => {
    if (!active || !local || local.genome !== genome) {
      return [];
    }
    return searchLocalIndex(local, trimmed, isKnownChromosome);
  }, [active, genome, isKnownChromosome, local, trimmed]);

  useEffect(() => {
    // Only the tail -- pseudogenes, lncRNAs, anything the table omits -- pays for
    // a round trip.
    if (!active || localMatches.length > 0) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchGenes({
        genome,
        term: trimmed,
        isKnownChromosome,
        signal: controller.signal,
      })
        .then((matches) => {
          if (!controller.signal.aborted) {
            setResolved({ term: trimmed, matches, status: 'ready' });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResolved({ term: trimmed, matches: [], status: 'error' });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, genome, isKnownChromosome, localMatches.length, trimmed]);

  if (!active) {
    return IDLE;
  }

  if (localMatches.length > 0) {
    return { matches: localMatches, status: 'ready' };
  }

  if (resolved?.term !== trimmed) {
    return { matches: [], status: 'searching' };
  }

  return { matches: resolved.matches, status: resolved.status };
}
