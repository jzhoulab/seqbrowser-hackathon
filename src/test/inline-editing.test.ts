import { describe, expect, it } from 'vitest';
import type { SequenceEdit } from '../types';

import {
  backspaceAtCaret,
  caretAfterEdit,
  clampCaret,
  deleteAtCaret,
  replaceRangeWithBase,
  typeBaseAtCaret,
} from '../features/sequence/inlineEditing';
import { applyEditsToSequence, displayCellsForWindow } from '../features/sequence/edits';
import { buildSequenceColumnLayout } from '../lib/sequenceColumnLayout';

const REFERENCE = 'ACGTACGTAA';
const REFERENCE_START = 1_000;
const REFERENCE_END = REFERENCE_START + REFERENCE.length;

function replay(edits: Parameters<typeof applyEditsToSequence>[2]): string {
  return applyEditsToSequence(REFERENCE, REFERENCE_START, edits).sequence;
}

describe('inline caret editing', () => {
  it('types a base into the sequence at the caret', () => {
    const { edits } = typeBaseAtCaret([], REFERENCE_START + 4, 'G', REFERENCE_END);

    expect(replay(edits)).toBe('ACGTGACGTAA');
  });

  it('keeps typed bases in the order they were struck', () => {
    let state = typeBaseAtCaret([], REFERENCE_START + 4, 'T', REFERENCE_END);
    state = typeBaseAtCaret(state.edits, state.caret, 'T', REFERENCE_END);
    state = typeBaseAtCaret(state.edits, state.caret, 'C', REFERENCE_END);

    // Two separate inserts at one coordinate would apply back to front and
    // spell this "CTT".
    expect(replay(state.edits)).toBe('ACGTTTCACGTAA');
    expect(state.edits).toHaveLength(1);
  });

  it('ignores a keystroke that is not a base', () => {
    const { edits } = typeBaseAtCaret([], REFERENCE_START + 2, '?', REFERENCE_END);

    expect(edits).toEqual([]);
    expect(replay(edits)).toBe(REFERENCE);
  });

  it('backspaces a typed base before touching the reference', () => {
    let state = typeBaseAtCaret([], REFERENCE_START + 4, 'G', REFERENCE_END);
    state = typeBaseAtCaret(state.edits, state.caret, 'G', REFERENCE_END);
    state = backspaceAtCaret(state.edits, state.caret, REFERENCE_START);

    expect(replay(state.edits)).toBe('ACGTGACGTAA');
    expect(state.caret).toBe(REFERENCE_START + 4);
  });

  it('drops the insertion entirely once its last typed base is taken back', () => {
    let state = typeBaseAtCaret([], REFERENCE_START + 4, 'G', REFERENCE_END);
    state = backspaceAtCaret(state.edits, state.caret, REFERENCE_START);

    expect(state.edits).toEqual([]);
    expect(replay(state.edits)).toBe(REFERENCE);
  });

  it('backspaces into the reference and steps the caret over the gap', () => {
    const state = backspaceAtCaret([], REFERENCE_START + 4, REFERENCE_START);

    expect(replay(state.edits)).toBe('ACGACGTAA');
    expect(state.caret).toBe(REFERENCE_START + 3);
  });

  it('refuses to backspace past the start of the window', () => {
    const state = backspaceAtCaret([], REFERENCE_START, REFERENCE_START);

    expect(state.edits).toEqual([]);
    expect(state.caret).toBe(REFERENCE_START);
  });

  it('forward-deletes the base under the caret', () => {
    const state = deleteAtCaret([], REFERENCE_START + 4, REFERENCE_START + REFERENCE.length);

    expect(replay(state.edits)).toBe('ACGTCGTAA');
    expect(state.caret).toBe(REFERENCE_START + 4);
  });

  it('refuses to forward-delete past the end of the window', () => {
    const end = REFERENCE_START + REFERENCE.length;
    const state = deleteAtCaret([], end, end);

    expect(state.edits).toEqual([]);
  });

  it('replaces a highlighted stretch and leaves the caret after it', () => {
    const state = replaceRangeWithBase([], REFERENCE_START + 2, REFERENCE_START + 6, 'G', REFERENCE_END);

    expect(replay(state.edits)).toBe('ACGGTAA');
    expect(state.caret).toBe(REFERENCE_START + 3);
  });

  it('treats an empty range as a plain keystroke', () => {
    const state = replaceRangeWithBase([], REFERENCE_START + 2, REFERENCE_START + 2, 'G', REFERENCE_END);

    expect(replay(state.edits)).toBe('ACGGTACGTAA');
  });

  it('keeps a run of edits replayable in order', () => {
    let state = typeBaseAtCaret([], REFERENCE_START + 1, 'G', REFERENCE_END);
    state = deleteAtCaret(state.edits, state.caret + 1, REFERENCE_START + REFERENCE.length);
    state = typeBaseAtCaret(state.edits, REFERENCE_START + 8, 'C', REFERENCE_END);

    expect(() => replay(state.edits)).not.toThrow();
    expect(replay(state.edits)).toContain('G');
  });

  it('clamps a caret to the window it belongs to', () => {
    expect(clampCaret(5, 10, 20)).toBe(10);
    expect(clampCaret(25, 10, 20)).toBe(20);
    expect(clampCaret(Number.NaN, 10, 20)).toBe(10);
    expect(clampCaret(14.6, 10, 20)).toBe(15);
  });
});

describe('editing inside a deleted stretch', () => {
  const deleted = [{ kind: 'delete' as const, start: REFERENCE_START + 2, end: REFERENCE_START + 5 }];

  it('records a base typed in the gap at the coordinate it will actually land on', () => {
    // Recorded at the caret, the edit said "in front of 1,002" while applying it
    // put the base in front of 1,005 -- the first coordinate still standing. The
    // column layout opened a slot for the first and the row rendered the second,
    // so the base was dropped and nothing appeared.
    const result = typeBaseAtCaret(deleted, REFERENCE_START + 3, 'G', REFERENCE_END);

    expect(result.edits).toContainEqual({
      kind: 'insert',
      start: REFERENCE_START + 5,
      sequence: 'G',
    });
    expect(result.caret).toBe(REFERENCE_START + 5);
    expect(replay(result.edits)).toBe('ACGCGTAA');
  });

  it('keeps consecutive keystrokes in one run, in order', () => {
    let state = typeBaseAtCaret(deleted, REFERENCE_START + 3, 'G', REFERENCE_END);
    state = typeBaseAtCaret(state.edits, state.caret, 'A', REFERENCE_END);
    state = typeBaseAtCaret(state.edits, state.caret, 'T', REFERENCE_END);

    expect(state.edits.filter((edit) => edit.kind === 'insert')).toHaveLength(1);
    expect(replay(state.edits)).toBe('ACGATCGTAA');
  });

  it('lands at the window edge when everything after the caret is gone', () => {
    const tail = [{ kind: 'delete' as const, start: REFERENCE_START + 6, end: REFERENCE_END }];

    const result = typeBaseAtCaret(tail, REFERENCE_START + 8, 'C', REFERENCE_END);

    expect(result.edits).toContainEqual({ kind: 'insert', start: REFERENCE_END, sequence: 'C' });
    expect(replay(result.edits)).toBe('ACGTACC');
  });

  it('hops the whole run where deletions abut', () => {
    const abutting = [
      { kind: 'delete' as const, start: REFERENCE_START + 2, end: REFERENCE_START + 4 },
      { kind: 'delete' as const, start: REFERENCE_START + 4, end: REFERENCE_START + 6 },
    ];

    const result = typeBaseAtCaret(abutting, REFERENCE_START + 3, 'T', REFERENCE_END);

    expect(result.caret).toBe(REFERENCE_START + 6);
  });

  it('steps the caret over a gap instead of deleting it twice', () => {
    const back = backspaceAtCaret(deleted, REFERENCE_START + 5, REFERENCE_START);
    expect(back.edits).toEqual(deleted);
    expect(back.caret).toBe(REFERENCE_START + 4);

    const forward = deleteAtCaret(deleted, REFERENCE_START + 2, REFERENCE_END);
    expect(forward.edits).toEqual(deleted);
    expect(forward.caret).toBe(REFERENCE_START + 3);
  });

  it('still takes back a base typed into the gap', () => {
    const typed = typeBaseAtCaret(deleted, REFERENCE_START + 3, 'G', REFERENCE_END);
    const back = backspaceAtCaret(typed.edits, typed.caret, REFERENCE_START);

    expect(back.edits.some((edit) => edit.kind === 'insert')).toBe(false);
    expect(replay(back.edits)).toBe(replay(deleted));
  });
});

/**
 * The invariant the bug broke: whatever coordinate an insertion is recorded at,
 * the row has to draw it at the same one. The layout opens its columns from the
 * edits and the row emits its cells from the applied tokens, so if those two
 * disagree the cell has no column to land in and is silently dropped.
 */
describe('recorded edits and drawn cells agree', () => {
  const cases: { name: string; edits: Parameters<typeof applyEditsToSequence>[2] }[] = [
    { name: 'a plain insertion', edits: [{ kind: 'insert', start: 1_003, sequence: 'GA' }] },
    {
      name: 'an insertion typed inside a deletion',
      edits: typeBaseAtCaret(
        [{ kind: 'delete', start: 1_002, end: 1_005 }],
        1_003,
        'G',
        REFERENCE_END,
      ).edits,
    },
    {
      name: 'an insertion at the far edge of a deletion',
      edits: typeBaseAtCaret(
        [{ kind: 'delete', start: 1_002, end: 1_005 }],
        1_005,
        'G',
        REFERENCE_END,
      ).edits,
    },
  ];

  for (const { name, edits } of cases) {
    it(`places every inserted base for ${name}`, () => {
      const cells = displayCellsForWindow(REFERENCE, REFERENCE_START, REFERENCE_START, REFERENCE_END, edits);
      const inserted = cells.filter((cell) => cell.kind === 'insertion');
      const layout = buildSequenceColumnLayout(edits, REFERENCE_START, REFERENCE_END);

      expect(inserted.length).toBeGreaterThan(0);
      for (const cell of inserted) {
        expect(
          cell.kind === 'insertion' ? layout.indexOfInsertion(cell.before, cell.offset) : -1,
        ).toBeGreaterThanOrEqual(0);
      }
    });
  }
});

describe('where the caret lands after an edit', () => {
  it('leaves it after an insertion, so the next keystroke extends the run', () => {
    // Insertions render in front of `start`, so `start` is the column just past
    // the run -- typing again there extends it rather than opening a second one.
    const edit = { kind: 'insert' as const, start: 1_004, sequence: 'GAT' };
    const caret = caretAfterEdit(edit);

    expect(caret).toBe(1_004);
    const next = typeBaseAtCaret([edit], caret, 'C', REFERENCE_END);
    expect(next.edits.filter((e) => e.kind === 'insert')).toHaveLength(1);
    expect(replay(next.edits)).toBe('ACGTGATCACGTAA');
  });

  it('leaves it where a deletion used to be', () => {
    expect(caretAfterEdit({ kind: 'delete', start: 1_002, end: 1_005 })).toBe(1_002);
  });

  it('leaves it after a substitution', () => {
    expect(caretAfterEdit({ kind: 'substitute', start: 1_002, end: 1_005, sequence: 'TTT' })).toBe(1_005);
  });
});

describe('typing several bases over a selection', () => {
  // Select four bases, type ACGT: the four bases become ACGT. The first key
  // substitutes the range; each further key fills the substitution rather than
  // opening an insert inside it (which stranded new bases among struck-out ones).
  const type = (state: { edits: readonly SequenceEdit[]; caret: number }, base: string) =>
    typeBaseAtCaret(state.edits, state.caret, base, 10_000);

  it('fills the substituted range key by key', () => {
    let state = replaceRangeWithBase([], 100, 104, 'A', 10_000);
    state = type(state, 'C');
    state = type(state, 'G');
    state = type(state, 'T');
    expect(state.edits).toEqual([{ kind: 'substitute', start: 100, end: 104, sequence: 'ACGT' }]);
    expect(state.caret).toBe(104);
  });

  it('typing past the filled range becomes ordinary insertion', () => {
    let state = replaceRangeWithBase([], 100, 102, 'A', 10_000);
    state = type(state, 'C');           // fills [100,102) with AC
    state = type(state, 'G');           // range full: this inserts
    expect(state.edits).toEqual([
      { kind: 'substitute', start: 100, end: 102, sequence: 'AC' },
      { kind: 'insert', start: 102, sequence: 'G' },
    ]);
  });

  it('a fresh caret elsewhere still inserts, untouched by an old substitution', () => {
    const state = replaceRangeWithBase([], 100, 104, 'A', 10_000);
    const elsewhere = typeBaseAtCaret(state.edits, 200, 'G', 10_000);
    expect(elsewhere.edits.at(-1)).toEqual({ kind: 'insert', start: 200, sequence: 'G' });
  });
});
