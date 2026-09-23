import type { TrackFeature } from '../types';

/**
 * Which strand the annotated genes at a coordinate run on.
 *
 * A splice model fed a plus-strand window scores the reverse-complement motif
 * as readily as the real one, so inside a plus-strand gene the AC and CT calls
 * are the model reading the wrong strand. Knowing where the genes are, and
 * which way they point, is what lets those be set aside -- and, where two genes
 * overlap on opposite strands, what stops them being set aside wrongly.
 *
 * Coverage is contributed by the annotation rows on screen and read by the
 * prediction rows, so a row that is scrolled out simply stops contributing.
 */

export type GeneStrand = '+' | '-';

export type GeneStrandSpan = {
  start: number;
  end: number;
  strand: GeneStrand;
  /** 'primary' marks the representative (MANE) transcript of a gene. */
  emphasis?: 'primary' | 'secondary';
};

export type GeneStrandCoverage = {
  /** Strands of the genes spanning `position`; empty where none do. */
  strandsAt(position: number): readonly GeneStrand[];
  /** No stranded annotation loaded: nothing can be judged against it. */
  isEmpty: boolean;
};

const NO_STRANDS: readonly GeneStrand[] = [];

export const EMPTY_GENE_STRAND_COVERAGE: GeneStrandCoverage = {
  strandsAt: () => NO_STRANDS,
  isEmpty: true,
};

/** Transcript spans, introns included: a splice site sits inside the gene. */
export function geneStrandSpansFrom(features: readonly TrackFeature[]): GeneStrandSpan[] {
  const spans: GeneStrandSpan[] = [];
  for (const feature of features) {
    if (feature.strand !== '+' && feature.strand !== '-') {
      continue;
    }
    if (!Number.isFinite(feature.start) || !Number.isFinite(feature.end) || feature.end <= feature.start) {
      continue;
    }
    spans.push({
      start: feature.start,
      end: feature.end,
      strand: feature.strand,
      emphasis: feature.emphasis,
    });
  }
  return spans;
}

/** Merge one strand's spans into disjoint ascending intervals. */
function mergeSpans(spans: readonly GeneStrandSpan[]): number[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  // Flattened [start, end, start, end, ...] so the lookup can binary-search it
  // without walking an array of objects on every call.
  const merged: number[] = [];
  for (const span of sorted) {
    const lastEnd = merged.length;
    if (lastEnd > 0 && span.start <= merged[lastEnd - 1]) {
      merged[lastEnd - 1] = Math.max(merged[lastEnd - 1], span.end);
      continue;
    }
    merged.push(span.start, span.end);
  }
  return merged;
}

function covers(merged: readonly number[], position: number): boolean {
  let low = 0;
  let high = merged.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = merged[mid * 2];
    const end = merged[mid * 2 + 1];
    if (position < start) {
      high = mid - 1;
    } else if (position >= end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

const PLUS_ONLY: readonly GeneStrand[] = ['+'];
const MINUS_ONLY: readonly GeneStrand[] = ['-'];
const BOTH: readonly GeneStrand[] = ['+', '-'];

function classify(onPlus: boolean, onMinus: boolean): readonly GeneStrand[] {
  if (onPlus && onMinus) {
    return BOTH;
  }
  if (onPlus) {
    return PLUS_ONLY;
  }
  return onMinus ? MINUS_ONLY : NO_STRANDS;
}

export function buildGeneStrandCoverage(spans: readonly GeneStrandSpan[]): GeneStrandCoverage {
  if (spans.length === 0) {
    return EMPTY_GENE_STRAND_COVERAGE;
  }

  const primary = spans.filter((span) => span.emphasis === 'primary');
  const primaryPlus = mergeSpans(primary.filter((span) => span.strand === '+'));
  const primaryMinus = mergeSpans(primary.filter((span) => span.strand === '-'));
  const plus = mergeSpans(spans.filter((span) => span.strand === '+'));
  const minus = mergeSpans(spans.filter((span) => span.strand === '-'));

  return {
    isEmpty: false,
    strandsAt(position) {
      // The representative transcripts answer first where there are any. A long
      // antisense lncRNA can blanket a gene -- ENSG00000232828 covers the whole
      // of GATA1 -- and counting it as a second gene would make every locus it
      // touches look ambiguous, which is how a plus-strand gene ends up keeping
      // its minus-strand calls.
      const fromPrimary = classify(
        covers(primaryPlus, position),
        covers(primaryMinus, position),
      );
      if (fromPrimary.length > 0) {
        return fromPrimary;
      }
      return classify(covers(plus, position), covers(minus, position));
    },
  };
}

type Registry = {
  subscribe(key: string, listener: () => void): () => void;
  version(key: string): number;
  /** Publish one row's spans; the returned function withdraws them. */
  register(key: string, contributorId: string, spans: readonly GeneStrandSpan[]): () => void;
  read(key: string): GeneStrandCoverage;
};

export function geneStrandCoverageKey(genome: string, chr: string): string {
  return `${genome}|${chr}`;
}

export function createGeneStrandRegistry(): Registry {
  const contributors = new Map<string, Map<string, readonly GeneStrandSpan[]>>();
  const coverages = new Map<string, GeneStrandCoverage>();
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();

  const rebuild = (key: string) => {
    const byContributor = contributors.get(key);
    const spans = byContributor ? [...byContributor.values()].flat() : [];
    if (spans.length === 0) {
      coverages.delete(key);
    } else {
      coverages.set(key, buildGeneStrandCoverage(spans));
    }
    versions.set(key, (versions.get(key) ?? 0) + 1);
    for (const listener of listeners.get(key) ?? []) {
      listener();
    }
  };

  return {
    subscribe(key, listener) {
      const keyListeners = listeners.get(key) ?? new Set<() => void>();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) {
          listeners.delete(key);
        }
      };
    },

    version(key) {
      return versions.get(key) ?? 0;
    },

    register(key, contributorId, spans) {
      const byContributor = contributors.get(key) ?? new Map<string, readonly GeneStrandSpan[]>();
      byContributor.set(contributorId, spans);
      contributors.set(key, byContributor);
      rebuild(key);

      return () => {
        const current = contributors.get(key);
        if (!current || !current.has(contributorId)) {
          return;
        }
        current.delete(contributorId);
        if (current.size === 0) {
          contributors.delete(key);
        }
        rebuild(key);
      };
    },

    read(key) {
      return coverages.get(key) ?? EMPTY_GENE_STRAND_COVERAGE;
    },
  };
}

export const geneStrandRegistry = createGeneStrandRegistry();
