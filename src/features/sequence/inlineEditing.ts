import { complementBase, sanitizeDna } from './edits';
import type { SequenceEdit } from '../../types';

/**
 * Caret-style editing for a modified sequence row.
 *
 * The reference row is edited by selecting a stretch and acting on it. A variant
 * row is a draft, and drafts are edited the way text is: put the caret
 * somewhere, type, backspace. These functions turn those keystrokes into the
 * same `SequenceEdit` list the rest of the pipeline already speaks, so a typed
 * base and a menu substitution reach the model by the same path.
 *
 * The caret sits *before* a genomic coordinate, so `caret === g` means "between
 * the base at g-1 and the base at g".
 */

export type InlineEditResult = {
  edits: SequenceEdit[];
  caret: number;
};

function insertEditAt(edits: readonly SequenceEdit[], caret: number): number {
  return edits.findIndex((edit) => edit.kind === 'insert' && edit.start === caret);
}

/** Has this coordinate already been deleted by an earlier edit? */
export function coordinateIsDeleted(edits: readonly SequenceEdit[], coordinate: number): boolean {
  return edits.some(
    (edit) => edit.kind === 'delete' && edit.start <= coordinate && coordinate < edit.end,
  );
}

/**
 * The first coordinate at or after `caret` that the current edits leave standing.
 *
 * A deleted stretch has no interior to type into. The row still draws a gap
 * there, so the caret can be put inside one, but an insertion recorded at an
 * interior coordinate lands somewhere else entirely once the edits are applied:
 * the base goes in front of the first surviving coordinate, while the column
 * layout opens a slot at the coordinate that was asked for. The two disagree and
 * the typed base is dropped on the floor.
 *
 * Snapping forward here is what keeps them talking about the same place.
 */
export function firstLiveCoordinate(
  edits: readonly SequenceEdit[],
  caret: number,
  maxCoordinate: number,
): number {
  let position = caret;
  // Deletions can abut or nest, so one hop is not always enough. Each hop moves
  // strictly forward past a deletion end, so this cannot run away.
  for (let guard = 0; guard <= edits.length; guard += 1) {
    const covering = edits.find(
      (edit) => edit.kind === 'delete' && edit.start <= position && position < edit.end,
    );
    if (!covering || covering.kind !== 'delete') {
      break;
    }
    position = covering.end;
  }
  // Past the window there is no column to land in, and both the layout and the
  // display put a trailing insertion at the edge.
  return Math.min(position, maxCoordinate);
}

/**
 * Type a base at the caret.
 *
 * Consecutive keystrokes extend the insertion already at this coordinate rather
 * than stacking separate edits: two inserts at the same start would otherwise
 * apply back-to-front and spell the typed text backwards.
 */
/**
 * What a keystroke means in genomic terms. On the minus strand the row reads
 * that strand 5'->3', so a typed base is stored as its complement and a typed
 * run, read left to right, runs DOWN the coordinates: each new base goes in
 * front of the previous one.
 */
function orientDna(dna: string, reversed: boolean): string {
  if (!reversed) {
    return dna;
  }
  let out = '';
  for (let index = dna.length - 1; index >= 0; index -= 1) {
    out += complementBase(dna[index] ?? 'N');
  }
  return out;
}

export function typeBaseAtCaret(
  edits: readonly SequenceEdit[],
  caret: number,
  base: string,
  maxCoordinate: number,
  reversed = false,
): InlineEditResult {
  const dna = orientDna(sanitizeDna(base), reversed);
  if (dna.length === 0) {
    return { edits: [...edits], caret };
  }

  // Typing over a selection substitutes the range with what is typed, however
  // many bases that turns out to be. The first key creates the substitute; each
  // further key lands here with the caret at the substitution's filling edge and
  // EXTENDS its sequence -- 'A' -> 'AC' -> 'ACG' -- until the range is full,
  // after which typing becomes ordinary insertion. Without this, the second key
  // opened an insert INSIDE the half-filled substitution: one replaced base,
  // the rest struck out, and the new bases stranded in the middle. On the minus
  // strand the range fills from its end downwards, and the caret follows.
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const existing = edits[index];
    if (existing.kind !== 'substitute') {
      continue;
    }
    if (reversed && existing.anchor === 'end') {
      const fillEdge = existing.end - existing.sequence.length;
      if (fillEdge === caret && fillEdge > existing.start) {
        const next = [...edits];
        next[index] = { ...existing, sequence: dna + existing.sequence };
        return { edits: next, caret: caret - dna.length };
      }
    } else if (!reversed && existing.anchor !== 'end') {
      const fillEdge = existing.start + existing.sequence.length;
      if (fillEdge === caret && fillEdge < existing.end) {
        const next = [...edits];
        next[index] = { ...existing, sequence: existing.sequence + dna };
        return { edits: next, caret: caret + dna.length };
      }
    }
  }

  // Typed inside a gap, the base belongs at the far edge of it -- which is where
  // it ends up anyway. The caret goes with it, so the reader can see where their
  // typing is landing.
  caret = firstLiveCoordinate(edits, caret, maxCoordinate);
  const index = insertEditAt(edits, caret);
  if (index >= 0) {
    const existing = edits[index];
    if (existing.kind === 'insert') {
      const next = [...edits];
      next[index] = { ...existing, sequence: reversed ? dna + existing.sequence : existing.sequence + dna };
      return { edits: next, caret };
    }
  }

  return {
    edits: [...edits, { kind: 'insert', start: caret, sequence: dna }],
    caret,
  };
}

/** The nearest coordinate at or above `from` (below `max`) that the edits leave standing. */
function nearestLiveAtOrAbove(edits: readonly SequenceEdit[], from: number, max: number): number | null {
  for (let position = from; position < max; position += 1) {
    if (!coordinateIsDeleted(edits, position)) {
      return position;
    }
  }
  return null;
}

/** The nearest coordinate below `from` (at or above `min`) that the edits leave standing. */
function nearestLiveBelow(edits: readonly SequenceEdit[], from: number, min: number): number | null {
  for (let position = from - 1; position >= min; position -= 1) {
    if (!coordinateIsDeleted(edits, position)) {
      return position;
    }
  }
  return null;
}

/**
 * Backspace: take back the last typed base if the caret follows one, otherwise
 * delete the reference base to the left and step over it.
 */
export function backspaceAtCaret(
  edits: readonly SequenceEdit[],
  caret: number,
  minCoordinate: number,
  reversed = false,
  maxCoordinate = Number.POSITIVE_INFINITY,
): InlineEditResult {
  const index = insertEditAt(edits, caret);
  if (index >= 0) {
    const existing = edits[index];
    if (existing.kind === 'insert' && existing.sequence.length > 0) {
      // The last typed base: last in the run on the plus strand, first on the
      // minus strand, where typing prepends.
      const shortened = reversed ? existing.sequence.slice(1) : existing.sequence.slice(0, -1);
      const next = [...edits];
      if (shortened.length === 0) {
        next.splice(index, 1);
      } else {
        next[index] = { ...existing, sequence: shortened };
      }
      return { edits: next, caret };
    }
  }

  if (reversed) {
    // Backspace takes the base to the LEFT of the caret. On the mirrored row that
    // is the base at the caret's own coordinate, or the next one still standing
    // above it; the caret moves up past it so the next press keeps going.
    const target = nearestLiveAtOrAbove(edits, caret, maxCoordinate);
    if (target === null) {
      return { edits: [...edits], caret };
    }
    return {
      edits: [...edits, { kind: 'delete', start: target, end: target + 1 }],
      caret: target + 1,
    };
  }

  if (caret <= minCoordinate) {
    return { edits: [...edits], caret };
  }

  // The base to the left is already gone: step over it rather than recording a
  // second deletion of the same coordinate.
  if (coordinateIsDeleted(edits, caret - 1)) {
    return { edits: [...edits], caret: caret - 1 };
  }

  return {
    edits: [...edits, { kind: 'delete', start: caret - 1, end: caret }],
    caret: caret - 1,
  };
}

/** Forward delete: remove the base the caret sits in front of. */
export function deleteAtCaret(
  edits: readonly SequenceEdit[],
  caret: number,
  maxCoordinate: number,
  reversed = false,
  minCoordinate = Number.NEGATIVE_INFINITY,
): InlineEditResult {
  if (reversed) {
    // Delete takes the base to the RIGHT of the caret. On the mirrored row that
    // is the nearest base still standing below the caret; the caret stays.
    const target = nearestLiveBelow(edits, caret, minCoordinate);
    if (target === null) {
      return { edits: [...edits], caret };
    }
    return {
      edits: [...edits, { kind: 'delete', start: target, end: target + 1 }],
      caret,
    };
  }

  if (caret >= maxCoordinate) {
    return { edits: [...edits], caret };
  }

  // Already gone: step past it, the way a caret steps over a gap.
  if (coordinateIsDeleted(edits, caret)) {
    return { edits: [...edits], caret: caret + 1 };
  }

  return {
    edits: [...edits, { kind: 'delete', start: caret, end: caret + 1 }],
    caret,
  };
}

/** Replace a highlighted stretch with a typed base, leaving the caret after it. */
/** Delete a highlighted run of bases, as Delete or Backspace does over a selection. */
export function deleteRange(
  edits: readonly SequenceEdit[],
  start: number,
  end: number,
): InlineEditResult {
  if (end <= start) {
    return { edits: [...edits], caret: start };
  }
  // Only what is still standing is deleted: a selection over a gap, or over
  // bases already gone, used to record a second deletion of the same
  // coordinates, drawn as a deeper gap that could never be taken back.
  const next = [...edits];
  let runStart: number | null = null;
  for (let position = start; position <= end; position += 1) {
    const live = position < end && !coordinateIsDeleted(edits, position);
    if (live && runStart === null) {
      runStart = position;
    } else if (!live && runStart !== null) {
      next.push({ kind: 'delete', start: runStart, end: position });
      runStart = null;
    }
  }
  return { edits: next, caret: start };
}

export function replaceRangeWithBase(
  edits: readonly SequenceEdit[],
  start: number,
  end: number,
  base: string,
  maxCoordinate: number,
  reversed = false,
): InlineEditResult {
  if (end <= start) {
    return typeBaseAtCaret(edits, start, base, maxCoordinate, reversed);
  }
  const dna = orientDna(sanitizeDna(base), reversed);
  if (dna.length === 0) {
    return { edits: [...edits], caret: reversed ? end : start };
  }

  // On the minus strand the selection is read from its end, so that is where
  // the typed bases go and where the caret then sits.
  if (reversed) {
    return {
      edits: [...edits, { kind: 'substitute', start, end, sequence: dna, anchor: 'end' }],
      caret: end - dna.length,
    };
  }
  return {
    edits: [...edits, { kind: 'substitute', start, end, sequence: dna }],
    caret: start + dna.length,
  };
}

export function clampCaret(caret: number, min: number, max: number): number {
  if (!Number.isFinite(caret)) {
    return min;
  }
  return Math.min(Math.max(Math.round(caret), min), max);
}

/**
 * Where the caret belongs once an edit has been made, the way a text field
 * leaves it: after what you typed, or where what you removed used to be.
 *
 * Used when an edit on the reference spawns a draft row -- the caret has to
 * arrive in the new row somewhere sensible, or the next keystroke goes back to
 * the reference and spawns a second row instead of continuing the first.
 */
export function caretAfterEdit(edit: SequenceEdit): number {
  if (edit.kind === 'insert') {
    // Insertions render in front of `start`, so the caret sits at `start`:
    // immediately after the run, where the next keystroke extends it.
    return edit.start;
  }
  if (edit.kind === 'substitute') {
    return edit.end;
  }
  return edit.start;
}
