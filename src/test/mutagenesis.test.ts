import { describe, expect, it } from 'vitest';
import {
  mutagenesisOutputPositions,
  mutagenesisValue,
  mutantAbsoluteChange,
  averageRows,
  largestChange,
  referenceBaseIndex,
  writeMutant,
} from '../lib/mutagenesis';
import { encodeDnaOneHotNcl } from '../data/sequenceDataSource';

// The mutagenesis row is arithmetic the worker does around the model. Its
// coordinate bookkeeping -- which output positions are on screen, on either
// strand, with insertions -- and its scoring are pinned here without a model.

describe('mutagenesisOutputPositions', () => {
  it('maps a genomic focus to forward output positions', () => {
    const positions = mutagenesisOutputPositions({
      focusStart: 1_010,
      focusEnd: 1_013,
      coveredStart: 1_000,
      genomicPositions: null,
      interiorStart: 500,
      outputLength: 100,
      reverseComplement: false,
    });
    expect(positions).toEqual([10, 11, 12]);
  });

  it('flips them on the minus strand, where the model read the reverse complement', () => {
    const positions = mutagenesisOutputPositions({
      focusStart: 1_010,
      focusEnd: 1_013,
      coveredStart: 1_000,
      genomicPositions: null,
      interiorStart: 500,
      outputLength: 100,
      reverseComplement: true,
    });
    expect(positions).toEqual([87, 88, 89]);
  });

  it('follows edits and takes inserted bases inside the focus along', () => {
    // Model sequence: flank of 2, then genomic 1000, 1001, an inserted base, 1002, 1003, flank of 2.
    const genomicPositions = [998, 999, 1_000, 1_001, null, 1_002, 1_003, 1_004, 1_005];
    const positions = mutagenesisOutputPositions({
      focusStart: 1_001,
      focusEnd: 1_003,
      coveredStart: 1_000,
      genomicPositions,
      interiorStart: 2,
      outputLength: 5,
      reverseComplement: false,
    });
    expect(positions).toEqual([1, 2, 3]);
  });

  it('is empty when nothing on screen is in the window', () => {
    expect(
      mutagenesisOutputPositions({
        focusStart: 5_000,
        focusEnd: 5_010,
        coveredStart: 1_000,
        genomicPositions: null,
        interiorStart: 0,
        outputLength: 100,
        reverseComplement: false,
      }),
    ).toEqual([]);
  });
});

describe('scoring', () => {
  it('writes a mutant that differs from the reference at exactly one base', () => {
    const encoded = encodeDnaOneHotNcl('ACGTN');
    expect(referenceBaseIndex(encoded, 5, 1)).toBe(1);
    expect(referenceBaseIndex(encoded, 5, 4)).toBe(-1);
    const batch = new Float32Array(2 * 4 * 5);
    writeMutant(batch, 20, encoded, 5, 1, 1, 3);
    const mutant = batch.subarray(20, 40);
    expect(Array.from(mutant)).toEqual(Array.from(encodeDnaOneHotNcl('ATGTN')));
    expect(Array.from(batch.subarray(0, 20))).toEqual(new Array(20).fill(0));
  });

  it('sums the absolute change within the context only, whichever way it went', () => {
    // One channel, 50 outputs. The reference has a site at 10 and one at 40.
    const reference = new Float32Array(50).fill(0.01);
    reference[10] = 0.9;
    reference[40] = 0.9;
    // The mutant loses the site at 10, gains one at 14, and the far site is untouched.
    const output = new Float32Array(50).fill(0.01);
    output[10] = 0.1;
    output[14] = 0.6;
    output[40] = 0.9;
    const change = mutantAbsoluteChange(output, 0, reference, 0, 12, 20, 50);
    // |0.1 - 0.9| + |0.6 - 0.01|: a loss and a gain both count, and both positively.
    expect(change).toBeCloseTo(0.8 + 0.59, 5);
    // Out of context (position 45, context 3): nothing changed there.
    expect(mutantAbsoluteChange(output, 0, reference, 0, 45, 3, 50)).toBeCloseTo(0, 6);
  });

  it('addresses one (mutant, channel) row of a batch and one channel of the reference', () => {
    const outputLength = 10;
    const reference = new Float32Array(2 * outputLength);
    reference[outputLength + 5] = 0.9; // channel 1, position 5
    // Batch of 2 mutants x 2 channels. Mutant 1, channel 1 drops the site to 0.4.
    const output = new Float32Array(2 * 2 * outputLength);
    output[(1 * 2 + 1) * outputLength + 5] = 0.4;
    expect(mutantAbsoluteChange(output, (1 * 2 + 1) * outputLength, reference, outputLength, 5, 5, outputLength)).toBeCloseTo(0.5, 5);
    // Mutant 0, channel 1 left it unchanged at 0 (a "site" fully lost).
    expect(mutantAbsoluteChange(output, (0 * 2 + 1) * outputLength, reference, outputLength, 5, 5, outputLength)).toBeCloseTo(0.9, 5);
  });

  it('finds where one series differs most from another, with both values', () => {
    const reference = Float32Array.from([0.01, 0.9, 0.01, 0.01]);
    const mean = Float32Array.from([0.01, 0.1, 0.6, 0.01]);
    // Lost 0.8 at index 1 beats gained 0.59 at index 2.
    expect(largestChange(mean, 0, reference, 0, 4)).toEqual({ index: 1, reference: reference[1], value: mean[1] });
    // Offsets address sub-ranges of either array.
    expect(largestChange(mean, 2, reference, 2, 2).index).toBe(0);
  });

  it('averages the three mutants position by position', () => {
    // Three rows of 4 in one buffer; average positions 1..2.
    const output = Float32Array.from([0, 0.3, 0.6, 0, 0, 0.0, 0.3, 0, 0, 0.6, 0.0, 0]);
    expect(Array.from(averageRows(output, [0, 4, 8], 1, 2)).map((v) => Number(v.toFixed(3)))).toEqual([0.3, 0.3]);
    expect(Array.from(averageRows(output, [], 0, 2))).toEqual([0, 0]);
  });

  it('is the mean over the substitutions, never negative', () => {
    expect(mutagenesisValue(0.6 + 0.3 + 0.9, 3)).toBeCloseTo(0.6, 6);
    expect(mutagenesisValue(0, 3)).toBe(0);
    expect(mutagenesisValue(1, 0)).toBe(0);
  });
});
