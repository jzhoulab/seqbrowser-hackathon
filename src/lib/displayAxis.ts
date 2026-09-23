import type { SequenceEdit } from '../types';
import {
  buildSequenceColumnLayout,
  rowHasPerBaseColumns,
  type SequenceColumnLayout,
} from './sequenceColumnLayout';

/**
 * The display axis: where a genomic position draws.
 *
 * Two things make x stop being `(bp - start) / bpPerPx`, and both used to be
 * handled piecemeal by whichever renderer noticed:
 *
 *  - Strand. On the minus strand the browser reads 5'->3' of that strand, which
 *    runs right-to-left in genomic coordinates. That is how puffin.zhoulab.io
 *    works and it is the only reading a biologist expects: the sequence is
 *    reverse-complemented, so a donor site's GT is a GT on screen. Complementing
 *    each letter in place -- the previous behaviour -- showed the minus strand
 *    written 3'->5', which is neither strand.
 *
 *  - Insertions. An edited row has columns for bases the genome does not have.
 *    Every track keeps one column per genomic base so it stays under the base it
 *    belongs to, and shows a gap where the inserted columns are. Deleted bases
 *    keep their column -- the genome is unchanged, only the variant is -- so
 *    alignment holds through a deletion too.
 *
 * The ruler follows the same axis, with one rule: labels stay genomic. An
 * inserted column owns no coordinate and gets no tick.
 *
 * Everything that draws along x asks this object, so the two concerns compose
 * instead of fighting: a minus-strand view with an insertion is just the column
 * list read backwards.
 */

export type DisplayAxis = {
  /** Genomic coordinate at the left edge of the window, before orientation. */
  readonly startBp: number;
  readonly endBp: number;
  readonly widthPx: number;
  readonly reversed: boolean;
  /** Present only when the window is narrow enough to show per-base columns AND has insertions. */
  readonly columns: SequenceColumnLayout | null;

  /** Left edge of the pixel span for a genomic position. */
  xOfBp(bp: number): number;
  /** Left edge and width for a half-open genomic interval, clipped to the window. */
  spanOf(startBp: number, endBp: number): { x: number; w: number } | null;
  /** Genomic coordinate under an x. Over an inserted column, returns the base it precedes. */
  bpAtX(x: number): number;
  /** Pixel span of an inserted column, for rows that draw inserted bases. */
  insertionSpan(before: number, offset: number): { x: number; w: number } | null;
  /** Pixel spans of every inserted column: the gaps other tracks should leave open. */
  insertionGaps(): Array<{ x: number; w: number; before: number; length: number }>;
  /**
   * Pixel span of every edit in the window, whatever its kind, so any track can
   * mark where the sequence was changed. Insertions report their opened columns;
   * deletions and substitutions report the genomic bases they cover.
   */
  editSpans(): EditSpan[];
};

export type EditSpan = {
  kind: SequenceEdit['kind'];
  x: number;
  w: number;
  /** Genomic extent of the edit, for labels. Insertions: the base they precede. */
  startBp: number;
  endBp: number;
};

export type DisplayAxisInput = {
  startBp: number;
  endBp: number;
  widthPx: number;
  reversed?: boolean;
  /** Insertions open columns; other edit kinds do not change the axis. */
  edits?: readonly SequenceEdit[];
};

export function buildDisplayAxis(input: DisplayAxisInput): DisplayAxis {
  const startBp = input.startBp;
  const endBp = Math.max(startBp + 1e-9, input.endBp);
  const widthPx = Math.max(1, input.widthPx);
  const reversed = input.reversed ?? false;
  const spanBp = endBp - startBp;

  const edits = input.edits ?? [];
  const insertions = edits.filter((edit) => edit.kind === 'insert');
  const columns =
    insertions.length > 0 && rowHasPerBaseColumns(spanBp, widthPx)
      ? buildSequenceColumnLayout(insertions, startBp, endBp)
      : null;

  // Orientation is applied last, as a mirror of the un-oriented x. Doing it once
  // here is what lets every renderer stay strand-agnostic.
  const orient = (x: number, w = 0) => (reversed ? widthPx - x - w : x);

  if (!columns) {
    const pxPerBp = widthPx / spanBp;
    const rawX = (bp: number) => (bp - startBp) * pxPerBp;
    return {
      startBp,
      endBp,
      widthPx,
      reversed,
      columns: null,
      xOfBp: (bp) => orient(rawX(bp)),
      spanOf: (s, e) => {
        const a = Math.max(startBp, s);
        const b = Math.min(endBp, e);
        if (b <= a) return null;
        const x = rawX(a);
        const w = (b - a) * pxPerBp;
        return { x: orient(x, w), w };
      },
      bpAtX: (x) => startBp + (reversed ? widthPx - x : x) / pxPerBp,
      insertionSpan: () => null,
      insertionGaps: () => [],
      editSpans: () => {
        const spans: EditSpan[] = [];
        for (const edit of edits) {
          if (edit.kind === 'insert') {
            // No columns at this zoom: mark the seam as a hairline at the insertion point.
            const x = rawX(edit.start);
            if (x >= -1 && x <= widthPx + 1) spans.push({ kind: 'insert', x: orient(x, 0), w: 0, startBp: edit.start, endBp: edit.start });
            continue;
          }
          const a = Math.max(startBp, edit.start);
          const b = Math.min(endBp, edit.end);
          if (b <= a) continue;
          const x = rawX(a);
          const w = (b - a) * pxPerBp;
          spans.push({ kind: edit.kind, x: orient(x, w), w, startBp: a, endBp: b });
        }
        return spans;
      },
    };
  }

  const colPx = columns.columnWidth * widthPx;
  const floorStart = Math.floor(startBp);
  // Columns tile [floor(start), ceil(end)); the fractional part of startBp is an
  // offset into the first column so sub-base panning stays smooth.
  const fracOffset = (startBp - floorStart) * colPx;
  const rawXOfBase = (bp: number) => {
    const index = columns.indexOfBase(Math.floor(bp));
    if (index < 0) {
      // Outside the tiled range: extrapolate linearly from the nearest edge so
      // clipped features still get a sensible (off-screen) x.
      const genomic = Math.floor(bp);
      const edgeIndex = genomic < floorStart ? 0 : columns.columns.length;
      const edgeBp = genomic < floorStart ? floorStart : Math.ceil(endBp);
      return edgeIndex * colPx + (bp - edgeBp) * colPx - fracOffset;
    }
    return index * colPx + (bp - Math.floor(bp)) * colPx - fracOffset;
  };

  return {
    startBp,
    endBp,
    widthPx,
    reversed,
    columns,
    xOfBp: (bp) => orient(rawXOfBase(bp)),
    spanOf: (s, e) => {
      const a = Math.max(startBp, s);
      const b = Math.min(endBp, e);
      if (b <= a) return null;
      const x0 = rawXOfBase(a);
      const x1 = rawXOfBase(b);
      const w = x1 - x0;
      return { x: orient(x0, w), w };
    },
    bpAtX: (x) => {
      const raw = reversed ? widthPx - x : x;
      const index = Math.floor((raw + fracOffset) / colPx);
      const column = columns.columns[Math.max(0, Math.min(columns.columns.length - 1, index))];
      if (!column) return startBp;
      if (column.kind === 'insertion') return column.before;
      const within = (raw + fracOffset) / colPx - index;
      return column.genomic + within;
    },
    insertionSpan: (before, offset) => {
      const index = columns.indexOfInsertion(before, offset);
      if (index < 0) return null;
      const x = index * colPx - fracOffset;
      return { x: orient(x, colPx), w: colPx };
    },
    editSpans: () => {
      const spans: EditSpan[] = [];
      for (const edit of edits) {
        if (edit.kind === 'insert') {
          const first = columns.indexOfInsertion(edit.start, 0);
          if (first < 0) continue;
          const x = first * colPx - fracOffset;
          const w = edit.sequence.length * colPx;
          spans.push({ kind: 'insert', x: orient(x, w), w, startBp: edit.start, endBp: edit.start });
          continue;
        }
        const a = Math.max(startBp, edit.start);
        const b = Math.min(endBp, edit.end);
        if (b <= a) continue;
        const x0 = rawXOfBase(a);
        const x1 = rawXOfBase(b);
        const w = x1 - x0;
        spans.push({ kind: edit.kind, x: orient(x0, w), w, startBp: a, endBp: b });
      }
      return spans;
    },
    insertionGaps: () => {
      const gaps: Array<{ x: number; w: number; before: number; length: number }> = [];
      let run: { start: number; before: number; length: number } | null = null;
      columns.columns.forEach((column, index) => {
        if (column.kind === 'insertion') {
          if (run && run.before === column.before) {
            run.length += 1;
          } else {
            if (run) gaps.push(finishRun(run));
            run = { start: index, before: column.before, length: 1 };
          }
        } else if (run) {
          gaps.push(finishRun(run));
          run = null;
        }
      });
      if (run) gaps.push(finishRun(run));
      return gaps;

      function finishRun(r: { start: number; before: number; length: number }) {
        const x = r.start * colPx - fracOffset;
        const w = r.length * colPx;
        return { x: orient(x, w), w, before: r.before, length: r.length };
      }
    },
  };
}

/** Reverse-complement, for rows that show letters on the minus strand. */
const COMPLEMENT: Record<string, string> = {
  A: 'T', T: 'A', C: 'G', G: 'C', N: 'N',
  a: 't', t: 'a', c: 'g', g: 'c', n: 'n',
};

export function complementBase(base: string): string {
  return COMPLEMENT[base] ?? base;
}

export function reverseComplement(sequence: string): string {
  let out = '';
  for (let i = sequence.length - 1; i >= 0; i -= 1) {
    out += complementBase(sequence[i]);
  }
  return out;
}

/**
 * Mark every edit on a canvas row, in the row's own coordinate space. Drawn under
 * the data so the band tints rather than hides it. Insertions at a zoom too wide
 * for columns have zero width and become a hairline seam.
 *
 * Colors are the same across every track so an edit reads as one event cutting
 * through the whole browser, not a per-track decoration.
 */
export const EDIT_BAND_COLORS: Record<SequenceEdit['kind'], string> = {
  insert: 'rgba(124, 58, 237, 0.18)',   // violet: new material
  delete: 'rgba(220, 38, 38, 0.16)',    // red: removed
  substitute: 'rgba(217, 119, 6, 0.18)', // amber: changed
};
export const EDIT_SEAM_COLORS: Record<SequenceEdit['kind'], string> = {
  insert: 'rgba(124, 58, 237, 0.9)',
  delete: 'rgba(220, 38, 38, 0.9)',
  substitute: 'rgba(217, 119, 6, 0.9)',
};

export function drawEditBands(
  context: CanvasRenderingContext2D,
  axis: DisplayAxis,
  top: number,
  height: number,
): void {
  for (const span of axis.editSpans()) {
    if (span.w < 1) {
      context.fillStyle = EDIT_SEAM_COLORS[span.kind];
      context.fillRect(Math.round(span.x) - 0.5, top, 1.5, height);
      continue;
    }
    context.fillStyle = EDIT_BAND_COLORS[span.kind];
    context.fillRect(span.x, top, span.w, height);
  }
}
