import { describe, expect, it } from 'vitest';

import {
  buildSequenceColumnLayout,
  layoutIsLinear,
  rowHasPerBaseColumns,
} from '../lib/sequenceColumnLayout';
import { extractInsertedScores } from '../features/sequence/edits';

describe('sequence column layout', () => {
  it('is linear when nothing is inserted', () => {
    const layout = buildSequenceColumnLayout([{ kind: 'delete', start: 12, end: 13 }], 10, 16);

    expect(layout.columns).toHaveLength(6);
    expect(layoutIsLinear(layout)).toBe(true);
    expect(layout.indexOfBase(10)).toBe(0);
    expect(layout.indexOfBase(15)).toBe(5);
  });

  it('opens a column for every inserted base, in front of its coordinate', () => {
    const layout = buildSequenceColumnLayout([{ kind: 'insert', start: 12, sequence: 'ATG' }], 10, 16);

    expect(layout.columns).toHaveLength(9);
    expect(layoutIsLinear(layout)).toBe(false);
    // Coordinates 10 and 11 come first, then the three inserted bases, then 12.
    expect(layout.indexOfBase(11)).toBe(1);
    expect(layout.indexOfInsertion(12, 0)).toBe(2);
    expect(layout.indexOfInsertion(12, 2)).toBe(4);
    expect(layout.indexOfBase(12)).toBe(5);
  });

  it('places a trailing insertion after the last base', () => {
    const layout = buildSequenceColumnLayout([{ kind: 'insert', start: 16, sequence: 'CC' }], 10, 16);

    expect(layout.columns).toHaveLength(8);
    expect(layout.indexOfInsertion(16, 0)).toBe(6);
  });

  it('reports a miss rather than guessing a column', () => {
    const layout = buildSequenceColumnLayout([{ kind: 'insert', start: 12, sequence: 'A' }], 10, 16);

    expect(layout.indexOfBase(99)).toBe(-1);
    expect(layout.indexOfInsertion(12, 4)).toBe(-1);
    expect(layout.indexOfInsertion(13, 0)).toBe(-1);
  });

  it('ignores insertions outside the window', () => {
    const layout = buildSequenceColumnLayout([{ kind: 'insert', start: 400, sequence: 'AAAA' }], 10, 16);

    expect(layoutIsLinear(layout)).toBe(true);
  });

  it('splits the row evenly across its columns', () => {
    const layout = buildSequenceColumnLayout([{ kind: 'insert', start: 12, sequence: 'AT' }], 10, 16);

    expect(layout.columnWidth).toBeCloseTo(1 / 8, 10);
    expect(layout.columnWidth * layout.columns.length).toBeCloseTo(1, 10);
  });
});

describe('scores for inserted bases', () => {
  it('keys each inserted score to the run it belongs to', () => {
    // Edited sequence: two reference bases, two inserted, one reference.
    const genomicPositions = [10, 11, null, null, 12];
    const values = Float32Array.from([0.1, 0.2, 0.7, 0.8, 0.3]);

    expect(extractInsertedScores(values, genomicPositions, 0)).toEqual([
      { before: 12, offset: 0, value: expect.closeTo(0.7, 5) },
      { before: 12, offset: 1, value: expect.closeTo(0.8, 5) },
    ]);
  });

  it('returns nothing when the sequence has no insertions', () => {
    expect(extractInsertedScores(Float32Array.from([0.1, 0.2]), [10, 11], 0)).toEqual([]);
  });

  it('drops a trailing insertion that never reaches a coordinate', () => {
    // Nothing follows the inserted bases, so there is no coordinate to key them
    // to inside this window.
    expect(extractInsertedScores(Float32Array.from([0.1, 0.9]), [10, null], 0)).toEqual([]);
  });

  it('accounts for the flank the model consumes but does not emit', () => {
    const genomicPositions = [10, 11, null, 12, 13];
    // Values cover the interior only: indices 1..3 of the edited sequence.
    const values = Float32Array.from([0.2, 0.7, 0.3]);

    expect(extractInsertedScores(values, genomicPositions, 1)).toEqual([
      { before: 12, offset: 0, value: expect.closeTo(0.7, 5) },
    ]);
  });
});

describe('when a row shares the sequence geometry', () => {
  it('does while the sequence draws one cell per base', () => {
    // 200 bp across 1012 px is ~5 px a base: the row is drawing cells, so the
    // gaps it opens are there to line up with.
    expect(rowHasPerBaseColumns(200, 1012)).toBe(true);
    expect(rowHasPerBaseColumns(674, 1012)).toBe(true);
  });

  it('does not once the sequence bins into a composition summary', () => {
    // Past ~1.5 px a base the sequence row stops drawing bases, so there is no
    // gap to align to -- and a column per base here would be 50,000 objects
    // rebuilt on every render.
    expect(rowHasPerBaseColumns(675, 1012)).toBe(false);
    expect(rowHasPerBaseColumns(50_000, 1012)).toBe(false);
  });

  it('says no on an unmeasured viewport rather than dividing by zero', () => {
    // A row that has not been laid out yet has no columns to share.
    expect(rowHasPerBaseColumns(0, 0)).toBe(false);
    expect(rowHasPerBaseColumns(1_000, 0)).toBe(false);
  });
});
