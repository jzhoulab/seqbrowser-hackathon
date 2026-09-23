import { describe, expect, it } from 'vitest';

import { createGeneIndex, type GeneEntry } from '../features/search/geneIndex';
import { parseJumpLocus } from '../features/search/jumpParser';
import { formatLocus, formatPosition, fromDisplayPosition } from '../lib/genomeMath';

// What a person types is 1-based inclusive, as UCSC, Ensembl and IGV print it.
// What comes back is internal: 0-based, half-open. Only the start moves.
describe('CZ-009 jump locus parser', () => {
  it('parses chr:start-end loci', () => {
    expect(parseJumpLocus('chr1:100-250')).toEqual({ chr: 'chr1', start: 99, end: 250 });
  });

  it('parses chr:pos loci as a single-base span', () => {
    expect(parseJumpLocus('chr2:4500')).toEqual({ chr: 'chr2', start: 4499, end: 4499 });
  });

  it('parses chr:pos@bpPerPx zoom jumps', () => {
    expect(parseJumpLocus('chr3:900@2.5')).toEqual({
      chr: 'chr3',
      start: 899,
      end: 899,
      bpPerPx: 2.5,
    });
  });

  it('uses fallback chromosome for bare positions', () => {
    expect(parseJumpLocus('1200', { fallbackChr: 'chrX' })).toEqual({
      chr: 'chrX',
      start: 1199,
      end: 1199,
    });
  });

  it('gives back the locus it was given, once it is displayed again', () => {
    // The round trip a reader actually performs: paste a locus from UCSC, read
    // it back off the browser. It used to come back one base to the right.
    for (const typed of ['chr7:5,527,148-5,530,601', 'chr1:1-1,000']) {
      const parsed = parseJumpLocus(typed)!;
      expect(formatLocus(parsed.chr, parsed.start, parsed.end)).toBe(typed);
    }
  });

  it('puts the first base of a chromosome at 1, not 0', () => {
    expect(formatPosition(0)).toBe('1');
    expect(fromDisplayPosition(1)).toBe(0);
  });
});

describe('CZ-010 gene index', () => {
  const genes: GeneEntry[] = [
    { symbol: 'TP53', chr: 'chr17', start: 7565097, end: 7590856 },
    { symbol: 'BRCA1', chr: 'chr17', start: 43044295, end: 43125482 },
    { symbol: 'BRCA2', chr: 'chr13', start: 32315086, end: 32400268 },
  ];

  it('returns exact matches by symbol', () => {
    const index = createGeneIndex(genes);

    expect(index.findExact('tp53')).toEqual(genes[0]);
  });

  it('returns prefix matches by symbol', () => {
    const index = createGeneIndex(genes);

    expect(index.findPrefix('br')).toEqual([genes[1], genes[2]]);
  });

  it('returns no matches when a symbol is absent', () => {
    const index = createGeneIndex(genes);

    expect(index.findExact('MYC')).toBeNull();
    expect(index.findPrefix('zzz')).toEqual([]);
  });
});
