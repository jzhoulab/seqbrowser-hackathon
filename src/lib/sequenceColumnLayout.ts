import type { SequenceEdit } from '../types';

/**
 * Column geometry for a window that contains inserted bases.
 *
 * A modified row draws one column per genomic base plus one for every inserted
 * base, so it no longer maps onto the viewport's linear bp-to-pixel scale. The
 * prediction drawn beneath that row has to use the very same geometry or the
 * bars stop standing under their letters, so the layout lives here rather than
 * inside either renderer.
 */

export type SequenceColumn =
  | { kind: 'base'; genomic: number }
  | { kind: 'insertion'; before: number; offset: number };

export type SequenceColumnLayout = {
  columns: SequenceColumn[];
  /** Fraction of the row each column occupies. */
  columnWidth: number;
  indexOfBase: (genomic: number) => number;
  indexOfInsertion: (before: number, offset: number) => number;
};

/** Insertions that fall inside the window, keyed by the coordinate they precede. */
function insertionLengths(
  edits: readonly SequenceEdit[],
  displayStart: number,
  displayEnd: number,
): Map<number, number> {
  const lengths = new Map<number, number>();
  for (const edit of edits) {
    if (edit.kind !== 'insert') {
      continue;
    }
    if (edit.start < displayStart || edit.start > displayEnd) {
      continue;
    }
    const length = edit.sequence.length;
    if (length <= 0) {
      continue;
    }
    lengths.set(edit.start, (lengths.get(edit.start) ?? 0) + length);
  }
  return lengths;
}

export function buildSequenceColumnLayout(
  edits: readonly SequenceEdit[],
  displayStart: number,
  displayEnd: number,
): SequenceColumnLayout {
  const start = Math.floor(displayStart);
  const end = Math.max(start + 1, Math.ceil(displayEnd));
  const lengths = insertionLengths(edits, start, end);

  const columns: SequenceColumn[] = [];
  const baseIndex = new Map<number, number>();
  const insertionIndex = new Map<string, number>();

  const pushInsertions = (before: number) => {
    const length = lengths.get(before) ?? 0;
    for (let offset = 0; offset < length; offset += 1) {
      insertionIndex.set(`${before}:${offset}`, columns.length);
      columns.push({ kind: 'insertion', before, offset });
    }
  };

  for (let genomic = start; genomic < end; genomic += 1) {
    pushInsertions(genomic);
    baseIndex.set(genomic, columns.length);
    columns.push({ kind: 'base', genomic });
  }
  pushInsertions(end);

  const columnWidth = columns.length > 0 ? 1 / columns.length : 1;

  return {
    columns,
    columnWidth,
    indexOfBase: (genomic: number) => baseIndex.get(Math.floor(genomic)) ?? -1,
    indexOfInsertion: (before: number, offset: number) =>
      insertionIndex.get(`${Math.floor(before)}:${Math.floor(offset)}`) ?? -1,
  };
}

/** True when the window has no insertions, and so still matches the bp scale. */
export function layoutIsLinear(layout: SequenceColumnLayout): boolean {
  return layout.columns.every((column) => column.kind === 'base');
}

/**
 * Narrowest a column may be drawn before per-base columns stop meaning anything.
 *
 * Matches the sequence row's own cut-off for drawing one cell per base: past it
 * the row bins into a composition summary, so there are no gaps for the tracks
 * below to align to -- and a column per base across a wide window would be a
 * large array rebuilt on every render for nothing.
 */
export const MIN_PX_PER_COLUMN = 1.5;

export function rowHasPerBaseColumns(spanBp: number, widthPx: number): boolean {
  return Math.max(1, widthPx) / Math.max(1, spanBp) >= MIN_PX_PER_COLUMN;
}
