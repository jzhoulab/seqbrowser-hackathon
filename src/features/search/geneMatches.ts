import { fromDisplayPosition } from '../../lib/genomeMath';

/**
 * Ranking for UCSC hgSearch responses.
 *
 * `api.genome.ucsc.edu/search` answers a symbol query with every track that
 * matched -- for `ACTB` that is 40+ tracks and ~220 KB, most of it mRNA
 * accessions, retro-pseudogene alignments, and per-version GENCODE copies of the
 * same locus. This module reduces that to the handful of gene-level hits a
 * person would actually jump to, so the network layer stays a thin fetch.
 */

export type GeneMatch = {
  symbol: string;
  chr: string;
  /** Internal: 0-based, half-open. `formatLocus` turns it into what a reader sees. */
  start: number;
  end: number;
  description?: string;
  /** UCSC track the hit came from; shown as provenance in the suggestion row. */
  source: string;
  /** Known from the shipped gene table; a jump opens the gene on its strand. */
  strand?: '+' | '-';
};

type UcscMatch = {
  position?: unknown;
  posName?: unknown;
  description?: unknown;
  canonical?: unknown;
};

type UcscPositionMatch = {
  trackName?: unknown;
  matches?: unknown;
};

export type UcscSearchPayload = {
  positionMatches?: unknown;
};

/**
 * Gene-level tracks only, best first. MANE leads because its span is the
 * representative transcript -- the thing a splice model should be pointed at --
 * where HGNC spans the whole locus including readthrough transcripts.
 */
const TRACK_PRIORITY: Record<string, number> = {
  mane: 0,
  knownGene: 1,
  hgnc: 2,
  refGene: 3,
};

const POSITION_PATTERN = /^([\w.]+):([\d,]+)-([\d,]+)$/;

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** `BRCA1 (NM_007294.4 / ENST00000357654.9)` -> `BRCA1`. */
function toSymbol(posName: string): string {
  const decoded = decodeEntities(posName).trim();
  const parenIndex = decoded.indexOf(' (');
  return (parenIndex > 0 ? decoded.slice(0, parenIndex) : decoded).trim();
}

/**
 * knownGene descriptions are concatenated annotation blobs -- PubMed ids,
 * interaction notes, transcript ids -- so they are dropped rather than shown.
 * A symbol that only appears in knownGene borrows its description below.
 */
function toDescription(value: unknown, trackName: string): string | undefined {
  if (typeof value !== 'string' || trackName === 'knownGene') {
    return undefined;
  }
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : undefined;
}

type ParsedPosition = { chr: string; start: number; end: number };

function parsePosition(value: unknown): ParsedPosition | null {
  if (typeof value !== 'string') {
    return null;
  }

  // Several tracks answer with an accession or a hub URL instead of a locus.
  const match = value.match(POSITION_PATTERN);
  if (!match) {
    return null;
  }

  const start = Number(match[2].replace(/,/g, ''));
  const end = Number(match[3].replace(/,/g, ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  // UCSC answers in 1-based inclusive coordinates. Internally a range is
  // 0-based half-open, so a hit is normalised here and nowhere else.
  return { chr: match[1], start: fromDisplayPosition(start), end };
}

/** 0 = exact symbol, 1 = symbol prefix, 2 = matched some other way (description). */
function matchClass(symbol: string, normalizedTerm: string): number {
  const key = symbol.toUpperCase();
  if (key === normalizedTerm) {
    return 0;
  }
  return key.startsWith(normalizedTerm) ? 1 : 2;
}

export type RankGeneMatchesOptions = {
  /** Drops alt/random/unplaced contigs the browser has no chromosome entry for. */
  isKnownChromosome?: (chr: string) => boolean;
  limit?: number;
};

export function rankGeneMatches(
  payload: UcscSearchPayload | null | undefined,
  term: string,
  options: RankGeneMatchesOptions = {},
): GeneMatch[] {
  const normalizedTerm = term.trim().toUpperCase();
  const positionMatches = payload?.positionMatches;
  if (normalizedTerm.length === 0 || !Array.isArray(positionMatches)) {
    return [];
  }

  const limit = options.limit ?? 8;
  const isKnownChromosome = options.isKnownChromosome ?? (() => true);

  type Scored = { match: GeneMatch; rank: number; priority: number };
  const scored: Scored[] = [];

  for (const group of positionMatches as UcscPositionMatch[]) {
    const trackName = typeof group?.trackName === 'string' ? group.trackName : '';
    const priority = TRACK_PRIORITY[trackName];
    if (priority === undefined || !Array.isArray(group.matches)) {
      continue;
    }

    for (const entry of group.matches as UcscMatch[]) {
      const position = parsePosition(entry?.position);
      if (!position || !isKnownChromosome(position.chr)) {
        continue;
      }

      const symbol = typeof entry?.posName === 'string' ? toSymbol(entry.posName) : '';
      if (symbol.length === 0 || /\s/.test(symbol)) {
        continue;
      }

      scored.push({
        match: {
          symbol,
          chr: position.chr,
          start: position.start,
          end: position.end,
          description: toDescription(entry?.description, trackName),
          source: trackName,
        },
        rank: matchClass(symbol, normalizedTerm),
        // A non-canonical knownGene transcript is a worse jump target than the
        // canonical one, but still better than the next track down.
        priority: priority + (trackName === 'knownGene' && entry?.canonical !== true ? 0.5 : 0),
      });
    }
  }

  // UCSC also matches on description text, which answers `BRCA1` with ATM, ATR,
  // and every other gene whose blurb mentions it. Those are only worth showing
  // when nothing matched by symbol at all.
  const hasSymbolMatch = scored.some((item) => item.rank < 2);
  const candidates = hasSymbolMatch ? scored.filter((item) => item.rank < 2) : scored;

  candidates.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.match.symbol.localeCompare(right.match.symbol);
  });

  const bySymbol = new Map<string, GeneMatch>();
  for (const item of candidates) {
    const key = item.match.symbol.toUpperCase();
    if (bySymbol.has(key)) {
      continue;
    }
    // Descriptions are richest on HGNC; borrow one when the winning row has none.
    if (!item.match.description) {
      const described = candidates.find(
        (candidate) =>
          candidate.match.symbol.toUpperCase() === key && candidate.match.description,
      );
      if (described) {
        item.match.description = described.match.description;
      }
    }
    bySymbol.set(key, item.match);
    if (bySymbol.size >= limit) {
      break;
    }
  }

  return [...bySymbol.values()];
}
