import { describe, expect, it } from 'vitest';

import {
  buildGeneStrandCoverage,
  createGeneStrandRegistry,
  geneStrandSpansFrom,
  EMPTY_GENE_STRAND_COVERAGE,
} from '../lib/geneStrandCoverage';
import { readSpliceMotif, spliceCallSuitsGeneStrand } from '../lib/spliceMotif';
import type { TrackFeature } from '../types';

function gene(start: number, end: number, strand: '+' | '-' | '.'): TrackFeature {
  return { start, end, score: 0, strand };
}

describe('collecting gene strands from an annotation row', () => {
  it('keeps the stranded features and drops the rest', () => {
    const spans = geneStrandSpansFrom([
      gene(100, 200, '+'),
      gene(300, 400, '-'),
      gene(500, 600, '.'),
      { start: 700, end: 700, score: 0, strand: '+' },
      { start: 800, end: 900, score: 0 },
    ]);

    expect(spans).toEqual([
      { start: 100, end: 200, strand: '+' },
      { start: 300, end: 400, strand: '-' },
    ]);
  });
});

describe('looking up the strand at a coordinate', () => {
  it('reports the strand of the gene covering it, half-open at the end', () => {
    const coverage = buildGeneStrandCoverage([{ start: 100, end: 200, strand: '+' }]);

    expect(coverage.strandsAt(100)).toEqual(['+']);
    expect(coverage.strandsAt(199)).toEqual(['+']);
    expect(coverage.strandsAt(200)).toEqual([]);
    expect(coverage.strandsAt(99)).toEqual([]);
  });

  it('lets the representative transcript answer for a locus it covers', () => {
    // GATA1 (+) sits entirely inside ENSG00000232828, a minus-strand lncRNA
    // running 48,636,632-48,801,376. Counting the lncRNA as a second gene made
    // the locus look ambiguous, and GATA1 kept its antisense calls.
    const coverage = buildGeneStrandCoverage([
      { start: 48_636_632, end: 48_801_376, strand: '-', emphasis: 'secondary' },
      { start: 48_783_121, end: 48_794_311, strand: '+', emphasis: 'primary' },
    ]);

    expect(coverage.strandsAt(48_790_000)).toEqual(['+']);
    // Outside GATA1 the lncRNA is the only annotation there is, so it answers.
    expect(coverage.strandsAt(48_700_000)).toEqual(['-']);
  });

  it('reports both where two representative transcripts genuinely overlap', () => {
    const coverage = buildGeneStrandCoverage([
      { start: 100, end: 300, strand: '+', emphasis: 'primary' },
      { start: 200, end: 400, strand: '-', emphasis: 'primary' },
    ]);

    expect(coverage.strandsAt(250)).toEqual(['+', '-']);
  });

  it('reports both where genes overlap on opposite strands', () => {
    const coverage = buildGeneStrandCoverage([
      { start: 100, end: 300, strand: '+' },
      { start: 200, end: 400, strand: '-' },
    ]);

    expect(coverage.strandsAt(150)).toEqual(['+']);
    expect(coverage.strandsAt(250)).toEqual(['+', '-']);
    expect(coverage.strandsAt(350)).toEqual(['-']);
  });

  it('merges the transcripts of one gene instead of treating them separately', () => {
    // A gene arrives as many overlapping transcripts; the union is the gene.
    const coverage = buildGeneStrandCoverage([
      { start: 100, end: 180, strand: '+' },
      { start: 120, end: 260, strand: '+' },
      { start: 400, end: 500, strand: '+' },
    ]);

    expect(coverage.strandsAt(200)).toEqual(['+']);
    expect(coverage.strandsAt(300)).toEqual([]);
    expect(coverage.strandsAt(450)).toEqual(['+']);
  });

  it('has nothing to say when no annotation was contributed', () => {
    expect(buildGeneStrandCoverage([]).isEmpty).toBe(true);
    expect(EMPTY_GENE_STRAND_COVERAGE.strandsAt(1)).toEqual([]);
  });
});

describe('rows contributing and withdrawing', () => {
  it('unions the rows on screen and drops a row that leaves', () => {
    const registry = createGeneStrandRegistry();
    const key = 'hg38|chr4';

    const removeGencode = registry.register(key, 'gencode', [{ start: 100, end: 200, strand: '+' }]);
    registry.register(key, 'refseq', [{ start: 300, end: 400, strand: '-' }]);

    expect(registry.read(key).strandsAt(150)).toEqual(['+']);
    expect(registry.read(key).strandsAt(350)).toEqual(['-']);

    removeGencode();
    expect(registry.read(key).strandsAt(150)).toEqual([]);
    expect(registry.read(key).strandsAt(350)).toEqual(['-']);
  });

  it('notifies subscribers so a prediction row repaints', () => {
    const registry = createGeneStrandRegistry();
    const key = 'hg38|chr4';
    let notified = 0;
    registry.subscribe(key, () => {
      notified += 1;
    });

    const remove = registry.register(key, 'gencode', [{ start: 1, end: 2, strand: '+' }]);
    expect(notified).toBe(1);
    expect(registry.version(key)).toBe(1);

    remove();
    expect(notified).toBe(2);
  });

  it('keeps chromosomes apart', () => {
    const registry = createGeneStrandRegistry();
    registry.register('hg38|chr4', 'gencode', [{ start: 100, end: 200, strand: '+' }]);

    expect(registry.read('hg38|chr7').strandsAt(150)).toEqual([]);
  });
});

/**
 * hg38 chr4:3,212,556-3,212,744, inside HTT (plus strand). A splice model calls four
 * sites: two that bound the annotated exon and two that are the same canonical
 * motifs read backwards.
 */
const HTT = {
  sequence:
    'GTTTCAGGGGATGCTGCACTGTATCAGTCCCTGCCCACTCTGGCCCGGGCCCTGGCACAGTACCTGGTGGTGGTCTCC' +
    'AAACTGCCCAGTCATTTGCACCTTCCTCCTGAGAAAGAGAAGGACATTGTGAAATTCGTGGTGGCAACCCTTGAGGTA' +
    'AGAGGCAGCTCGGGAGCTCAGTGTTGCTGTGG',
  start: 3_212_556,
  end: 3_212_744,
};

describe('deciding whether a call belongs on the gene it sits in', () => {
  const plusOnly = buildGeneStrandCoverage([{ start: 3_074_681, end: 3_243_960, strand: '+' }]);
  const at = (position: number, kind: 'donor' | 'acceptor') =>
    spliceCallSuitsGeneStrand(readSpliceMotif(HTT, position, kind), plusOnly.strandsAt(position));

  it('keeps the two calls that bound the annotated exon', () => {
    expect(at(3_212_563, 'acceptor')).toBe(true);
    expect(at(3_212_708, 'donor')).toBe(true);
  });

  it('sets aside the two that are the motif read on the other strand', () => {
    expect(at(3_212_619, 'donor')).toBe(false);
    expect(at(3_212_661, 'acceptor')).toBe(false);
  });

  it('keeps an antisense call where a gene runs both ways', () => {
    const both = buildGeneStrandCoverage([
      { start: 3_074_681, end: 3_243_960, strand: '+' },
      { start: 3_212_000, end: 3_213_000, strand: '-' },
    ]);

    expect(
      spliceCallSuitsGeneStrand(readSpliceMotif(HTT, 3_212_619, 'donor'), both.strandsAt(3_212_619)),
    ).toBe(true);
  });

  it('keeps everything where no gene is annotated', () => {
    expect(spliceCallSuitsGeneStrand(readSpliceMotif(HTT, 3_212_619, 'donor'), [])).toBe(true);
  });

  it('keeps a call on neither canonical form, which may be a minor-class intron', () => {
    // GC-AG and AT-AC introns are real and rare; a strand filter must not be
    // what removes them.
    expect(spliceCallSuitsGeneStrand({ dinucleotide: 'GC', strand: null }, ['+'])).toBe(true);
  });
});
