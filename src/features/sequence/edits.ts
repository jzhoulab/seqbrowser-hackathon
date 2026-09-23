import { normalizeBase } from '../../data/sequenceDataSource';
import type { SequenceEdit } from '../../types';

export type SequenceToken = {
  base: string;
  genomic: number | null;
};

export function sanitizeDna(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/U/g, 'T')
    .replace(/[^ACGTN]/g, '');
}

const COMPLEMENT: Record<string, string> = {
  A: 'T',
  C: 'G',
  G: 'C',
  T: 'A',
  N: 'N',
};

/**
 * Complement of a single base, for the minus-strand row under the reference.
 *
 * The row is complemented in place rather than reversed: each column keeps its
 * genomic coordinate, so a base and its partner stay in the same column. Reading
 * the minus strand 5'->3' means reading that row right to left.
 */
export function complementBase(base: string): string {
  const upper = base.toUpperCase();
  return COMPLEMENT[upper] ?? 'N';
}

export function serializeSequenceEdits(edits: readonly SequenceEdit[] | undefined): string {
  if (!edits || edits.length === 0) {
    return '';
  }
  return JSON.stringify(edits);
}

export function clipEditsToRange(
  edits: readonly SequenceEdit[],
  rangeStart: number,
  rangeEnd: number,
): SequenceEdit[] {
  const clipped: SequenceEdit[] = [];
  for (const edit of edits) {
    if (edit.kind === 'insert') {
      if (edit.start >= rangeStart && edit.start <= rangeEnd) {
        clipped.push(edit);
      }
      continue;
    }

    const start = Math.max(edit.start, rangeStart);
    const end = Math.min(edit.end, rangeEnd);
    if (end <= start) {
      continue;
    }
    if (edit.start >= rangeStart && edit.end <= rangeEnd) {
      clipped.push(edit);
      continue;
    }
    if (edit.kind === 'delete') {
      clipped.push({ kind: 'delete', start, end });
      continue;
    }
    const origLen = Math.max(0, edit.end - edit.start);
    if (origLen > 0 && edit.sequence.length === origLen) {
      clipped.push({
        kind: 'substitute',
        start,
        end,
        sequence: edit.sequence.slice(start - edit.start, end - edit.start),
      });
      continue;
    }
    clipped.push(edit);
  }
  return clipped;
}

export function tokensFromReference(sequence: string, start: number): SequenceToken[] {
  const tokens: SequenceToken[] = new Array(sequence.length);
  for (let index = 0; index < sequence.length; index += 1) {
    tokens[index] = {
      base: normalizeBase(sequence[index] ?? 'N'),
      genomic: start + index,
    };
  }
  return tokens;
}

function firstIndexAtGenomic(tokens: readonly SequenceToken[], position: number): number {
  for (let index = 0; index < tokens.length; index += 1) {
    const genomic = tokens[index]?.genomic;
    if (genomic !== null && genomic !== undefined && genomic >= position) {
      return index;
    }
  }
  return tokens.length;
}

/** Exclusive end for a genomic half-open range, leaving insertions at `end` in place. */
function exclusiveEndIndex(tokens: readonly SequenceToken[], end: number): number {
  let index = firstIndexAtGenomic(tokens, end);
  while (index > 0 && tokens[index - 1]?.genomic === null) {
    index -= 1;
  }
  return index;
}

function tokensFromDna(sequence: string, genomicStart: number | null, mapLength = 0): SequenceToken[] {
  const tokens: SequenceToken[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    tokens.push({
      base: normalizeBase(sequence[index] ?? 'N'),
      genomic: genomicStart !== null && index < mapLength ? genomicStart + index : null,
    });
  }
  return tokens;
}

export function applyEdit(tokens: SequenceToken[], edit: SequenceEdit): SequenceToken[] {
  if (edit.kind === 'insert') {
    const dna = sanitizeDna(edit.sequence);
    if (dna.length === 0) {
      return tokens;
    }
    const index = firstIndexAtGenomic(tokens, edit.start);
    return [...tokens.slice(0, index), ...tokensFromDna(dna, null), ...tokens.slice(index)];
  }

  const from = firstIndexAtGenomic(tokens, edit.start);
  const to = exclusiveEndIndex(tokens, edit.end);
  if (edit.kind === 'delete') {
    return [...tokens.slice(0, from), ...tokens.slice(to)];
  }

  const dna = sanitizeDna(edit.sequence);
  const mapped = Math.max(0, edit.end - edit.start);
  // A half-filled substitution keeps its typed bases at the end it is being
  // filled from; the rest of the range reads as deleted until it is filled.
  const genomicStart = edit.anchor === 'end' ? edit.end - Math.min(dna.length, mapped) : edit.start;
  return [...tokens.slice(0, from), ...tokensFromDna(dna, genomicStart, mapped), ...tokens.slice(to)];
}

export function applyEdits(tokens: SequenceToken[], edits: readonly SequenceEdit[]): SequenceToken[] {
  return edits.reduce((current, edit) => applyEdit(current, edit), tokens);
}

export function applyEditsToSequence(
  sequence: string,
  sequenceStart: number,
  edits: readonly SequenceEdit[],
): { sequence: string; genomicPositions: (number | null)[] } {
  const relevant = clipEditsToRange(edits, sequenceStart, sequenceStart + sequence.length);
  const tokens = applyEdits(tokensFromReference(sequence, sequenceStart), relevant);
  return {
    sequence: tokens.map((token) => token.base).join(''),
    genomicPositions: tokens.map((token) => token.genomic),
  };
}

export type SequenceDisplayCell =
  | {
      kind: 'base';
      genomic: number;
      referenceBase: string;
      displayBase: string;
      deleted: boolean;
      substituted: boolean;
    }
  | {
      kind: 'insertion';
      /** Genomic coordinate this run sits in front of. */
      before: number;
      base: string;
      /** Position within its own insertion run, for keys and caret offsets. */
      offset: number;
    };

/**
 * Lay a window out as display cells: one per genomic base, plus a cell of its
 * own for every inserted base.
 *
 * Inserted bases used to be painted onto the columns to their left, which put
 * them over coordinates they do not belong to -- a 4 bp insertion at p rendered
 * across p-3..p. Giving them their own cells costs the row its 1:1 alignment
 * with the reference above (it shifts right by the insertion length, the way a
 * pairwise alignment does) and buys back a position that is actually theirs.
 */
export function displayCellsForWindow(
  referenceSequence: string,
  referenceStart: number,
  displayStart: number,
  displayEnd: number,
  edits: readonly SequenceEdit[],
): SequenceDisplayCell[] {
  const span = Math.max(0, displayEnd - displayStart);
  if (span === 0) {
    return [];
  }

  const referenceBaseAt = (genomic: number) =>
    normalizeBase(referenceSequence[genomic - referenceStart] ?? 'N');

  const relevant = clipEditsToRange(edits, referenceStart, referenceStart + referenceSequence.length);
  const tokens = applyEdits(tokensFromReference(referenceSequence, referenceStart), relevant);

  const presentByGenomic = new Map<number, string>();
  const insertionsBefore = new Map<number, string[]>();
  let pending: string[] = [];

  for (const token of tokens) {
    if (token.genomic === null) {
      pending.push(token.base);
      continue;
    }
    if (pending.length > 0) {
      insertionsBefore.set(token.genomic, [...(insertionsBefore.get(token.genomic) ?? []), ...pending]);
      pending = [];
    }
    presentByGenomic.set(token.genomic, token.base);
  }
  if (pending.length > 0) {
    // Trailing insertions belong after the last base in the window.
    insertionsBefore.set(displayEnd, [...(insertionsBefore.get(displayEnd) ?? []), ...pending]);
  }

  const cells: SequenceDisplayCell[] = [];
  const pushInsertions = (genomic: number) => {
    const run = insertionsBefore.get(genomic);
    if (!run) {
      return;
    }
    run.forEach((base, offset) => {
      cells.push({ kind: 'insertion', before: genomic, base: normalizeBase(base), offset });
    });
  };

  for (let genomic = displayStart; genomic < displayEnd; genomic += 1) {
    pushInsertions(genomic);
    const referenceBase = referenceBaseAt(genomic);
    const present = presentByGenomic.get(genomic);
    cells.push({
      kind: 'base',
      genomic,
      referenceBase,
      displayBase: present ?? referenceBase,
      deleted: present === undefined,
      substituted: present !== undefined && present !== referenceBase,
    });
  }
  pushInsertions(displayEnd);

  return cells;
}

/**
 * Scatter per-base model output from an edited sequence back onto genomic
 * coordinates. Inserted bases are omitted; deleted genomic positions stay NaN.
 */
export type InsertedBaseScore = {
  /** Genomic coordinate the inserted run sits in front of. */
  before: number;
  /** Position within that run. */
  offset: number;
  value: number;
};

/**
 * Pull out the scores that belong to inserted bases.
 *
 * The genomic remap has nowhere to put these -- an inserted base has no
 * coordinate -- so they used to be dropped, which meant the model scored the
 * sequence you typed and the browser threw the answer away. They come back
 * keyed by the coordinate their run sits in front of, which is how the display
 * lays them out too.
 */
export function extractInsertedScores(
  values: Float32Array,
  genomicPositions: readonly (number | null)[],
  flankBp: number,
): InsertedBaseScore[] {
  const seqLen = genomicPositions.length;
  if (values.length === 0 || seqLen === 0) {
    return [];
  }

  const interiorStart = Math.min(Math.max(0, flankBp), seqLen);
  const interiorEnd = Math.max(interiorStart, seqLen - Math.max(0, flankBp));
  const interiorLen = Math.max(1, interiorEnd - interiorStart);

  // Which coordinate each run of inserted bases precedes, and where in the run
  // each edited index falls.
  const anchorByIndex = new Map<number, { before: number; offset: number }>();
  let pending: number[] = [];
  for (let index = 0; index < seqLen; index += 1) {
    const genomic = genomicPositions[index];
    if (genomic === null || genomic === undefined) {
      pending.push(index);
      continue;
    }
    pending.forEach((editedIndex, offset) => {
      anchorByIndex.set(editedIndex, { before: genomic, offset });
    });
    pending = [];
  }

  const scores: InsertedBaseScore[] = [];
  for (let index = 0; index < values.length; index += 1) {
    let editedIndex: number;
    if (values.length === seqLen) {
      editedIndex = index;
    } else if (values.length === interiorLen) {
      editedIndex = interiorStart + index;
    } else {
      editedIndex = interiorStart + Math.floor((index / values.length) * interiorLen);
    }
    const anchor = anchorByIndex.get(editedIndex);
    if (!anchor) {
      continue;
    }
    const value = values[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    scores.push({ before: anchor.before, offset: anchor.offset, value });
  }

  return scores;
}

export function remapEditedScoresToGenomic(
  values: Float32Array,
  genomicPositions: readonly (number | null)[],
  flankBp: number,
  genomicCoveredStart: number,
  genomicCoveredEnd: number,
): Float32Array {
  const coveredLength = Math.max(0, genomicCoveredEnd - genomicCoveredStart);
  const remapped = new Float32Array(coveredLength);
  remapped.fill(Number.NaN);
  if (values.length === 0 || genomicPositions.length === 0 || coveredLength === 0) {
    return remapped;
  }

  const seqLen = genomicPositions.length;
  const interiorStart = Math.min(Math.max(0, flankBp), seqLen);
  const interiorEnd = Math.max(interiorStart, seqLen - Math.max(0, flankBp));
  const interiorLen = Math.max(1, interiorEnd - interiorStart);

  for (let index = 0; index < values.length; index += 1) {
    let editedIndex: number;
    if (values.length === seqLen) {
      editedIndex = index;
    } else if (values.length === interiorLen) {
      editedIndex = interiorStart + index;
    } else {
      editedIndex = interiorStart + Math.floor((index / values.length) * interiorLen);
    }
    const genomic = genomicPositions[editedIndex];
    if (genomic === null || genomic === undefined || genomic < genomicCoveredStart || genomic >= genomicCoveredEnd) {
      continue;
    }
    remapped[genomic - genomicCoveredStart] = values[index] ?? Number.NaN;
  }

  return remapped;
}
