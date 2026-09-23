/**
 * The N padding a transcript model was trained with.
 *
 * A transcript model's training windows are cut from one canonical transcript per gene,
 * read in the transcript's direction, with CL_max/2 = 500 N in place of the
 * genomic sequence beyond each end (SplicePuffin create_datasets,
 * utils_masking.create_datapoints). Fed the raw genome instead, the model sees
 * upstream and downstream sequence it never saw in training, and calls sites
 * there that the padded model does not. So, for a window scored on a strand,
 * the bases within `padBp` outside a same-strand canonical transcript become N,
 * unless another same-strand transcript covers them.
 */

export type TranscriptSpan = {
  start: number;
  end: number;
  strand: '+' | '-';
};

export type GenomicInterval = { start: number; end: number };

/** Genomic intervals, within `[windowStart, windowEnd)`, that read as N on `strand`. */
export function transcriptPaddingIntervals(
  spans: readonly TranscriptSpan[],
  strand: '+' | '-',
  windowStart: number,
  windowEnd: number,
  padBp: number,
): GenomicInterval[] {
  const same = spans.filter((span) => span.strand === strand && span.end > span.start);
  if (same.length === 0 || padBp <= 0) {
    return [];
  }
  const covered = (position: number) => same.some((span) => span.start <= position && position < span.end);
  const intervals: GenomicInterval[] = [];
  for (const span of same) {
    // Both ends: 500 N before the start and 500 N after the end, whichever
    // strand, since the pair is symmetric in genomic coordinates.
    for (const [lo, hi] of [[span.start - padBp, span.start], [span.end, span.end + padBp]] as const) {
      let runStart: number | null = null;
      for (let position = Math.max(lo, windowStart); position <= Math.min(hi, windowEnd); position += 1) {
        const pad = position < Math.min(hi, windowEnd) && !covered(position);
        if (pad && runStart === null) {
          runStart = position;
        } else if (!pad && runStart !== null) {
          intervals.push({ start: runStart, end: position });
          runStart = null;
        }
      }
    }
  }
  return mergeIntervals(intervals);
}

function mergeIntervals(intervals: GenomicInterval[]): GenomicInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged: GenomicInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The window's sequence with the padding intervals written as N. */
export function applyTranscriptPadding(
  sequence: string,
  windowStart: number,
  intervals: readonly GenomicInterval[],
): string {
  if (intervals.length === 0) {
    return sequence;
  }
  const bases = sequence.split('');
  for (const interval of intervals) {
    const from = Math.max(0, interval.start - windowStart);
    const to = Math.min(bases.length, interval.end - windowStart);
    for (let index = from; index < to; index += 1) {
      bases[index] = 'N';
    }
  }
  return bases.join('');
}
