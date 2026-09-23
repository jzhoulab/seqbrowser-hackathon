import { describe, expect, it } from 'vitest';
import {
  backspaceAtCaret,
  deleteAtCaret,
  deleteRange,
  replaceRangeWithBase,
  typeBaseAtCaret,
} from '../features/sequence/inlineEditing';
import { applyEditsToSequence, displayCellsForWindow } from '../features/sequence/edits';

// On the minus strand the row is mirrored and reads that strand 5'->3': left is
// up the coordinates, a typed letter is the complement of what is stored, and a
// typed run grows downwards. Backspace and Delete keep their screen directions.
// And whichever strand: deleting what is already deleted records nothing.

const REFERENCE = 'ACGTACGTAA';
const START = 1_000;
const END = START + REFERENCE.length;
const replay = (edits: Parameters<typeof applyEditsToSequence>[2]) => applyEditsToSequence(REFERENCE, START, edits).sequence;

describe('typing on the minus strand', () => {
  it('stores the complement of the typed base, in front of the caret coordinate', () => {
    const { edits, caret } = typeBaseAtCaret([], START + 4, 'T', END, true);
    expect(edits).toEqual([{ kind: 'insert', start: START + 4, sequence: 'A' }]);
    expect(caret).toBe(START + 4);
    expect(replay(edits)).toBe('ACGTAACGTAA');
  });

  it('a typed run reads left to right on the screen, so it grows down the coordinates', () => {
    // Read on the minus strand, the user types T then G; stored genomic order is comp(G) comp(T).
    let state = typeBaseAtCaret([], START + 4, 'T', END, true);
    state = typeBaseAtCaret(state.edits, state.caret, 'G', END, true);
    expect(state.edits).toEqual([{ kind: 'insert', start: START + 4, sequence: 'CA' }]);
    const cells = displayCellsForWindow(REFERENCE, START, START, END, state.edits).filter((cell) => cell.kind === 'insertion');
    // Mirrored and complemented for display: the run shows T then G left to right.
    expect([...cells].reverse().map((cell) => (cell.kind === 'insertion' ? cell.base : ''))).toEqual(['A', 'C']);
  });

  it('backspace takes back the last typed base of a run', () => {
    let state = typeBaseAtCaret([], START + 4, 'T', END, true);
    state = typeBaseAtCaret(state.edits, state.caret, 'G', END, true);
    state = backspaceAtCaret(state.edits, state.caret, START, true, END);
    expect(state.edits).toEqual([{ kind: 'insert', start: START + 4, sequence: 'A' }]);
  });
});

describe('deleting on the minus strand', () => {
  it('backspace removes the base to the left on the screen: the caret coordinate, then the next up', () => {
    let state = backspaceAtCaret([], START + 4, START, true, END);
    expect(state.edits).toEqual([{ kind: 'delete', start: START + 4, end: START + 5 }]);
    expect(state.caret).toBe(START + 5);
    state = backspaceAtCaret(state.edits, state.caret, START, true, END);
    expect(state.edits).toHaveLength(2);
    expect(state.edits[1]).toEqual({ kind: 'delete', start: START + 5, end: START + 6 });
    expect(replay(state.edits)).toBe('ACGTGTAA');
  });

  it('delete removes the base to the right on the screen: the next one down, caret staying put', () => {
    let state = deleteAtCaret([], START + 4, END, true, START);
    expect(state.edits).toEqual([{ kind: 'delete', start: START + 3, end: START + 4 }]);
    expect(state.caret).toBe(START + 4);
    state = deleteAtCaret(state.edits, state.caret, END, true, START);
    expect(state.edits[1]).toEqual({ kind: 'delete', start: START + 2, end: START + 3 });
  });

  it('stops at the window edges', () => {
    expect(backspaceAtCaret([], END, START, true, END).edits).toEqual([]);
    expect(deleteAtCaret([], START, END, true, START).edits).toEqual([]);
  });
});

describe('typing over a selection on the minus strand', () => {
  it('fills the range from its end, complemented, and the caret follows the fill', () => {
    // Selection covers coordinates 4..6; the user reads them left to right as 6, 5, 4.
    let state = replaceRangeWithBase([], START + 4, START + 7, 'A', END, true);
    expect(state.edits).toEqual([{ kind: 'substitute', start: START + 4, end: START + 7, sequence: 'T', anchor: 'end' }]);
    expect(state.caret).toBe(START + 6);
    const cells = displayCellsForWindow(REFERENCE, START, START, END, state.edits);
    const at = (genomic: number) => cells.find((cell) => cell.kind === 'base' && cell.genomic === genomic);
    expect(at(START + 6)).toMatchObject({ displayBase: 'T', deleted: false });
    expect(at(START + 5)).toMatchObject({ deleted: true });
    expect(at(START + 4)).toMatchObject({ deleted: true });

    state = typeBaseAtCaret(state.edits, state.caret, 'G', END, true);
    expect(state.edits).toEqual([{ kind: 'substitute', start: START + 4, end: START + 7, sequence: 'CT', anchor: 'end' }]);
    expect(state.caret).toBe(START + 5);
    // Coordinates 5 and 6 now read C, T; coordinate 4 is still to be filled.
    expect(replay(state.edits)).toBe('ACGTCTTAA');
  });
});

describe('deleting what is already deleted', () => {
  it('records only the bases still standing', () => {
    const first = deleteRange([], START + 3, START + 5);
    const again = deleteRange(first.edits, START + 2, START + 7);
    expect(again.edits).toEqual([
      { kind: 'delete', start: START + 3, end: START + 5 },
      { kind: 'delete', start: START + 2, end: START + 3 },
      { kind: 'delete', start: START + 5, end: START + 7 },
    ]);
    expect(replay(again.edits)).toBe('ACTAA');
  });

  it('is a no-op over a range that is entirely gone', () => {
    const first = deleteRange([], START + 3, START + 5);
    expect(deleteRange(first.edits, START + 3, START + 5).edits).toEqual(first.edits);
  });
});
