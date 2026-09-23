import { describe, expect, it } from 'vitest';
import {
  dequantizeUnit,
  forwardAnchors,
  mutantCurveBytes,
  mutantOverlayIndex,
  mutantRecordToOverlay,
  quantizeUnit,
  type MutantCurveRecord,
} from '../lib/mutagenesis';
import { applyEditsToSequence, extractInsertedScores } from '../features/sequence/edits';

// What the hover keeps per scored base: the mean of its three mutants, every
// channel, quantised to 16 bits, in display order with each position's column.
// The arithmetic and the column bookkeeping here are what the overlay trusts.

describe('unit quantisation', () => {
  it('keeps 0 and 1 exact and clips outside [0, 1]', () => {
    const out = new Uint16Array(4);
    quantizeUnit(Float32Array.from([0, 1, 1.4, -0.2]), out, 0);
    expect(Array.from(dequantizeUnit(out, 0, 4))).toEqual([0, 1, 1, 0]);
  });

  it('round-trips mid-range probabilities to well under a pixel', () => {
    const values = [0.02, 0.25, 0.5, 0.75, 0.98];
    const out = new Uint16Array(values.length);
    quantizeUnit(values, out, 0);
    const back = dequantizeUnit(out, 0, values.length);
    values.forEach((value, index) => expect(Math.abs(back[index]! - value)).toBeLessThan(1e-4));
  });

  it('keeps the nines of a confident call, which a linear 16-bit code lost', () => {
    // A linear code stored 1 - 1e-5 as 1 - 1.5e-5: half a nine off on a
    // -log(1-p) axis. Log-odds codes keep 1 - p to a fraction of a percent,
    // down to where float32 itself runs out (it steps by 6e-8 under 1).
    for (const complement of [1e-3, 1e-5, 1e-6]) {
      const out = new Uint16Array(1);
      quantizeUnit([1 - complement], out, 0);
      const back = dequantizeUnit(out, 0, 1)[0]!;
      expect(Math.abs(1 - back - complement) / complement, `1 - ${complement}`).toBeLessThan(0.07);
    }
    const out = new Uint16Array(1);
    quantizeUnit([1e-6], out, 0);
    expect(Math.abs(dequantizeUnit(out, 0, 1)[0]! - 1e-6) / 1e-6).toBeLessThan(1e-3);
  });
});

describe('forwardAnchors', () => {
  it('is the covered coordinates when there are no edits', () => {
    const { anchors, insertOffsets } = forwardAnchors(null, 2, 4, 1_000);
    expect(Array.from(anchors)).toEqual([1_000, 1_001, 1_002, 1_003]);
    expect(Array.from(insertOffsets)).toEqual([-1, -1, -1, -1]);
  });

  it('names an inserted base by the coordinate its run precedes, as the rows place its score', () => {
    // Flank of 1 on each side; interior: 1000, 1001, two inserted bases, 1002.
    const genomicPositions = [999, 1_000, 1_001, null, null, 1_002, 1_003];
    const { anchors, insertOffsets } = forwardAnchors(genomicPositions, 1, 5, 1_000);
    expect(Array.from(anchors)).toEqual([1_000, 1_001, 1_002, 1_002, 1_002]);
    expect(Array.from(insertOffsets)).toEqual([-1, -1, 0, 1, -1]);
  });

  it('agrees with extractInsertedScores on a real edit', () => {
    const reference = 'ACGTACGTACGT';
    const edited = applyEditsToSequence(reference, 100, [{ kind: 'insert', start: 105, sequence: 'GG' }]);
    const flank = 2;
    const outputLength = edited.genomicPositions.length - 2 * flank;
    const { anchors, insertOffsets } = forwardAnchors(edited.genomicPositions, flank, outputLength, 102);
    const scores = Float32Array.from(edited.genomicPositions.map((_, index) => index));
    const inserted = extractInsertedScores(scores, edited.genomicPositions, flank);
    for (const entry of inserted) {
      const f = entry.value - flank;
      expect([anchors[f], insertOffsets[f]]).toEqual([entry.before, entry.offset]);
    }
    expect(inserted).toHaveLength(2);
  });

  it('puts a trailing run in front of the next coordinate', () => {
    const { anchors, insertOffsets } = forwardAnchors([1_000, 1_001, null], 0, 3, 1_000);
    expect(Array.from(anchors)).toEqual([1_000, 1_001, 1_002]);
    expect(Array.from(insertOffsets)).toEqual([-1, -1, 0]);
  });
});

describe('mutant overlay', () => {
  const record = (): MutantCurveRecord => {
    // Two channels, three columns: 1000, an inserted base before 1001, 1001.
    const reference = new Uint16Array(6);
    quantizeUnit([0.1, 0.5, 0.9, 0, 0, 0.3], reference, 0);
    const mean = new Uint16Array(6);
    quantizeUnit([0.1, 0.5, 0.2, 0, 0.4, 0.3], mean, 0);
    return {
      refBase: 'G',
      alts: 'ACT',
      length: 3,
      channelCount: 2,
      anchors: Int32Array.from([1_000, 1_001, 1_001]),
      insertOffsets: Int16Array.from([-1, 0, -1]),
      reference,
      mean,
    };
  };

  it('serves the record dequantised, columns intact', () => {
    const overlay = mutantRecordToOverlay(record(), 1_001);
    expect(overlay.position).toBe(1_001);
    expect(overlay.alts).toBe('ACT');
    expect(Array.from(overlay.reference.subarray(0, 3)).map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.5, 0.9]);
    expect(Array.from(overlay.mean.subarray(0, 3)).map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.5, 0.2]);
    expect(Number(overlay.mean[4]!.toFixed(3))).toBe(0.4);
  });

  it('finds a genomic base by coordinate and an inserted base by (before, offset)', () => {
    const indexOf = mutantOverlayIndex(mutantRecordToOverlay(record(), 1_001));
    expect(indexOf(1_000)).toBe(0);
    expect(indexOf(1_001)).toBe(2);
    expect(indexOf(1_001, 0)).toBe(1);
    expect(indexOf(1_001, 1)).toBe(-1);
    expect(indexOf(999)).toBe(-1);
  });

  it('accounts its bytes', () => {
    expect(mutantCurveBytes(record())).toBe(6 * 2 + 6 * 2 + 3 * 4 + 3 * 2 + 96);
  });
});
