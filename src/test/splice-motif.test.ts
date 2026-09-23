import { describe, expect, it } from 'vitest';

import {
  formatSpliceMotif,
  readSpliceMotif,
  spliceSiteKindFromName,
} from '../lib/spliceMotif';

/**
 * hg38 chr4:3,212,556-3,212,744, inside HTT. A splice model calls four sites here: two
 * on the plus strand that bound an annotated exon, and two that are the same
 * canonical motifs read on the minus strand.
 */
const HTT = {
  sequence:
    'GTTTCAGGGGATGCTGCACTGTATCAGTCCCTGCCCACTCTGGCCCGGGCCCTGGCACAGTACCTGGTGGTGGTCTCC' +
    'AAACTGCCCAGTCATTTGCACCTTCCTCCTGAGAAAGAGAAGGACATTGTGAAATTCGTGGTGGCAACCCTTGAGGTA' +
    'AGAGGCAGCTCGGGAGCTCAGTGTTGCTGTGG',
  start: 3_212_556,
  end: 3_212_744,
};

describe('reading the motif under a splice call', () => {
  it('names a plus-strand acceptor by the AG in front of it', () => {
    // chr4:3,212,563 is the first base of the exon; TTTCAG|G.
    expect(readSpliceMotif(HTT, 3_212_563, 'acceptor')).toEqual({ dinucleotide: 'AG', strand: '+' });
  });

  it('names a plus-strand donor by the GT after it', () => {
    // chr4:3,212,708 is the last base of the exon; G|GTAAGA.
    expect(readSpliceMotif(HTT, 3_212_708, 'donor')).toEqual({ dinucleotide: 'GT', strand: '+' });
  });

  it('reads a donor sitting on AC as the same site on the minus strand', () => {
    // CAGTAC|C: nothing canonical to the right, but AC to the left is GT read
    // the other way round.
    expect(readSpliceMotif(HTT, 3_212_619, 'donor')).toEqual({ dinucleotide: 'AC', strand: '-' });
  });

  it('reads an acceptor sitting on CT as the same site on the minus strand', () => {
    expect(readSpliceMotif(HTT, 3_212_661, 'acceptor')).toEqual({ dinucleotide: 'CT', strand: '-' });
  });

  it('does not let a donor borrow the acceptor motif, or the reverse', () => {
    // The plus-strand donor at 3,212,708 has GT to its right, which is nothing
    // an acceptor can use: an acceptor wants AG left or CT right.
    expect(readSpliceMotif(HTT, 3_212_708, 'acceptor')).toEqual({ dinucleotide: 'GA', strand: null });
  });

  it('reports the plus-strand dinucleotide when neither strand is canonical', () => {
    // chr4:3,212,570 sits in ...GGGGATG..., canonical on neither reading.
    const motif = readSpliceMotif(HTT, 3_212_570, 'donor');
    expect(motif?.strand).toBeNull();
    expect(motif?.dinucleotide).toMatch(/^[ACGT]{2}$/);
  });

  it('declines rather than reading past the end of the window', () => {
    expect(readSpliceMotif(HTT, HTT.end - 1, 'donor')).toBeNull();
    expect(readSpliceMotif(HTT, HTT.start, 'acceptor')).toBeNull();
    expect(readSpliceMotif({ sequence: '', start: 0, end: 0 }, 10, 'donor')).toBeNull();
  });
});

describe('deciding which site a series reports', () => {
  it('reads the kind out of the series name', () => {
    expect(spliceSiteKindFromName('Donor (post-GRU)')).toBe('donor');
    expect(spliceSiteKindFromName('Acceptor (post-GRU)')).toBe('acceptor');
  });

  it('falls through to the next name when the first says nothing', () => {
    expect(spliceSiteKindFromName(undefined, 'splice-post-acceptor')).toBe('acceptor');
  });

  it('guesses nothing for a series that names neither', () => {
    expect(spliceSiteKindFromName('Coverage', 'phyloP')).toBeNull();
    expect(spliceSiteKindFromName()).toBeNull();
  });
});

describe('formatting', () => {
  it('marks the strand, and marks a call that is on neither', () => {
    expect(formatSpliceMotif({ dinucleotide: 'GT', strand: '+' })).toBe('GT +');
    expect(formatSpliceMotif({ dinucleotide: 'AC', strand: '-' })).toBe('AC −');
    expect(formatSpliceMotif({ dinucleotide: 'TG', strand: null })).toBe('TG ?');
  });
});
