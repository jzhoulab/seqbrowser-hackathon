import { describe, expect, it } from 'vitest';
import { buildDisplayAxis, reverseComplement } from '../lib/displayAxis';

// The one object every renderer asks "where does this base draw?". Both strand
// and insertions live here so they compose instead of each renderer handling one.

const WIDTH = 1000;

describe('display axis — linear', () => {
  const axis = buildDisplayAxis({ startBp: 1000, endBp: 1100, widthPx: WIDTH });

  it('maps bp to x linearly and back', () => {
    expect(axis.xOfBp(1000)).toBe(0);
    expect(axis.xOfBp(1050)).toBe(500);
    expect(axis.bpAtX(500)).toBeCloseTo(1050, 6);
  });

  it('clips a span to the window', () => {
    expect(axis.spanOf(990, 1010)).toEqual({ x: 0, w: 100 });
    expect(axis.spanOf(2000, 2100)).toBeNull();
  });
});

describe('display axis — minus strand', () => {
  const plus = buildDisplayAxis({ startBp: 1000, endBp: 1100, widthPx: WIDTH });
  const minus = buildDisplayAxis({ startBp: 1000, endBp: 1100, widthPx: WIDTH, reversed: true });

  it('mirrors x so genomic coordinates decrease left to right', () => {
    // The window's first base draws at the RIGHT edge on the minus strand.
    expect(minus.xOfBp(1000)).toBe(WIDTH);
    expect(minus.xOfBp(1100)).toBe(0);
    expect(minus.xOfBp(1025)).toBeCloseTo(WIDTH - plus.xOfBp(1025), 6);
  });

  it('a span keeps its width and lands mirrored', () => {
    const p = plus.spanOf(1010, 1020)!;
    const m = minus.spanOf(1010, 1020)!;
    expect(m.w).toBeCloseTo(p.w, 6);
    expect(m.x).toBeCloseTo(WIDTH - p.x - p.w, 6);
  });

  it('bpAtX inverts xOfBp on the minus strand too', () => {
    for (const bp of [1000, 1033, 1099.5]) {
      expect(minus.bpAtX(minus.xOfBp(bp))).toBeCloseTo(bp, 6);
    }
  });

  it('reverse-complements a sequence, not just complements it', () => {
    // A donor's GT on the minus strand must read as GT on screen.
    expect(reverseComplement('ACGT')).toBe('ACGT');
    expect(reverseComplement('AAGT')).toBe('ACTT');
    expect(reverseComplement('GGGA')).toBe('TCCC');
  });
});

describe('display axis — insertions', () => {
  // 20 bp at 50 px/base, with GG inserted before 1010: 22 columns.
  const edits = [{ kind: 'insert' as const, start: 1010, sequence: 'GG' }];
  const axis = buildDisplayAxis({ startBp: 1000, endBp: 1020, widthPx: WIDTH, edits });

  it('opens columns for inserted bases', () => {
    expect(axis.columns?.columns.length).toBe(22);
  });

  it('keeps a genomic base under its own column on both sides of the edit', () => {
    const colPx = WIDTH / 22;
    expect(axis.xOfBp(1005)).toBeCloseTo(5 * colPx, 6);
    // 1010 sits AFTER the two inserted columns.
    expect(axis.xOfBp(1010)).toBeCloseTo(12 * colPx, 6);
    expect(axis.xOfBp(1015)).toBeCloseTo(17 * colPx, 6);
  });

  it('reports the gap every other track must leave open', () => {
    const gaps = axis.insertionGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].before).toBe(1010);
    expect(gaps[0].length).toBe(2);
    expect(gaps[0].x).toBeCloseTo(10 * (WIDTH / 22), 6);
    expect(gaps[0].w).toBeCloseTo(2 * (WIDTH / 22), 6);
  });

  it('a genomic span straddling the insertion is widened by the gap, so it stays under its bases', () => {
    const colPx = WIDTH / 22;
    const span = axis.spanOf(1008, 1012)!;
    // 4 genomic bases + 2 inserted columns between them.
    expect(span.w).toBeCloseTo(6 * colPx, 6);
  });

  it('hover over an inserted column resolves to the base it precedes', () => {
    const colPx = WIDTH / 22;
    expect(Math.floor(axis.bpAtX(10.5 * colPx))).toBe(1010);
    expect(Math.floor(axis.bpAtX(5.5 * colPx))).toBe(1005);
  });

  it('deletions and substitutions do not change the axis', () => {
    const same = buildDisplayAxis({
      startBp: 1000, endBp: 1020, widthPx: WIDTH,
      edits: [
        { kind: 'delete', start: 1003, end: 1005 },
        { kind: 'substitute', start: 1012, end: 1013, sequence: 'A' },
      ],
    });
    expect(same.columns).toBeNull();
    expect(same.xOfBp(1015)).toBe(750);
  });

  it('does not open columns when the view is too wide to show per-base cells', () => {
    const wide = buildDisplayAxis({ startBp: 0, endBp: 100_000, widthPx: WIDTH, edits });
    expect(wide.columns).toBeNull();
  });
});

describe('display axis — minus strand with an insertion', () => {
  const edits = [{ kind: 'insert' as const, start: 1010, sequence: 'GG' }];
  const plus = buildDisplayAxis({ startBp: 1000, endBp: 1020, widthPx: WIDTH, edits });
  const minus = buildDisplayAxis({ startBp: 1000, endBp: 1020, widthPx: WIDTH, edits, reversed: true });

  it('is the plus layout read backwards', () => {
    const p = plus.spanOf(1005, 1006)!;
    const m = minus.spanOf(1005, 1006)!;
    expect(m.w).toBeCloseTo(p.w, 6);
    expect(m.x).toBeCloseTo(WIDTH - p.x - p.w, 6);
    const pg = plus.insertionGaps()[0];
    const mg = minus.insertionGaps()[0];
    expect(mg.x).toBeCloseTo(WIDTH - pg.x - pg.w, 6);
  });
});
