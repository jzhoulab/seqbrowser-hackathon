import { describe, expect, it } from 'vitest';
import {
  applyEditsToSequence,
  complementBase,
  displayCellsForWindow,
  remapEditedScoresToGenomic,
  sanitizeDna,
} from '../features/sequence/edits';

describe('sequence edits', () => {
  it('sanitizes pasted DNA and maps U to T', () => {
    expect(sanitizeDna(' acgT uN-xyz ')).toBe('ACGTTN');
  });

  it('substitutes, deletes, and inserts while keeping genomic coordinates', () => {
    const result = applyEditsToSequence('ACGTACGT', 100, [
      { kind: 'substitute', start: 102, end: 104, sequence: 'TT' },
      { kind: 'delete', start: 105, end: 107 },
      { kind: 'insert', start: 100, sequence: 'GG' },
    ]);

    expect(result.sequence).toBe('GGACTTAT');
    expect(result.genomicPositions).toEqual([null, null, 100, 101, 102, 103, 104, 107]);
  });

  it('gives every inserted base a cell of its own, in front of its coordinate', () => {
    const cells = displayCellsForWindow('ACGTAA', 10, 10, 16, [
      { kind: 'insert', start: 12, sequence: 'ATG' },
    ]);

    // Six reference bases plus three inserted ones, and the insertion sits
    // between coordinate 11 and 12 rather than painted over 10..12.
    expect(cells).toHaveLength(9);
    const inserted = cells.filter((cell) => cell.kind === 'insertion');
    expect(inserted.map((cell) => (cell.kind === 'insertion' ? cell.base : ''))).toEqual(['A', 'T', 'G']);
    expect(inserted.every((cell) => cell.kind === 'insertion' && cell.before === 12)).toBe(true);

    const bases = cells.filter((cell) => cell.kind === 'base');
    expect(bases.map((cell) => (cell.kind === 'base' ? cell.displayBase : '')).join('')).toBe('ACGTAA');
    expect(cells.slice(0, 2).every((cell) => cell.kind === 'base')).toBe(true);
    expect(cells[2]?.kind).toBe('insertion');
  });

  it('keeps a deleted base in place and marks it, so the row still lines up', () => {
    const cells = displayCellsForWindow('ACGTAA', 10, 10, 16, [
      { kind: 'insert', start: 12, sequence: 'CC' },
      { kind: 'delete', start: 14, end: 15 },
      { kind: 'substitute', start: 11, end: 12, sequence: 'T' },
    ]);

    const bases = cells.filter((cell) => cell.kind === 'base');
    expect(bases).toHaveLength(6);
    expect(bases.map((cell) => (cell.kind === 'base' ? cell.displayBase : '')).join('')).toBe('ATGTAA');
    expect(bases[1]?.kind === 'base' && bases[1].substituted).toBe(true);
    expect(bases[4]?.kind === 'base' && bases[4].deleted).toBe(true);
    expect(cells.filter((cell) => cell.kind === 'insertion')).toHaveLength(2);
  });

  it('places a trailing insertion after the last base in the window', () => {
    const cells = displayCellsForWindow('ACGT', 10, 10, 14, [
      { kind: 'insert', start: 14, sequence: 'GG' },
    ]);

    expect(cells).toHaveLength(6);
    expect(cells[4]?.kind).toBe('insertion');
    expect(cells[5]?.kind).toBe('insertion');
  });

  it('returns plain bases when there is nothing edited', () => {
    const cells = displayCellsForWindow('ACGT', 10, 10, 14, []);

    expect(cells.every((cell) => cell.kind === 'base')).toBe(true);
    expect(cells).toHaveLength(4);
  });

  it('scatters edited model scores back onto genomic positions', () => {
    const values = Float32Array.from([0.1, 0.2, 0.9, 0.4, 0.5]);
    const genomicPositions = [10, 11, null, 12, 14];
    const remapped = remapEditedScoresToGenomic(values, genomicPositions, 0, 10, 15);

    expect(Array.from(remapped, (value) => (Number.isNaN(value) ? null : Number(value.toFixed(2))))).toEqual([
      0.1,
      0.2,
      0.4,
      null,
      0.5,
    ]);
  });
});

describe('base complement', () => {
  it('pairs the four bases and leaves N alone', () => {
    expect([...'ACGTN'].map(complementBase)).toEqual(['T', 'G', 'C', 'A', 'N']);
  });

  it('is case-insensitive', () => {
    expect([...'acgt'].map(complementBase)).toEqual(['T', 'G', 'C', 'A']);
  });

  it('reports anything unreadable as N', () => {
    expect(complementBase('?')).toBe('N');
    expect(complementBase('')).toBe('N');
  });
});
