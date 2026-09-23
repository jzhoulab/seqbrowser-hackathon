export type GenomicRange = {
  start: number;
  end: number;
  span: number;
};

export type CenterBounds = {
  strictMin: number;
  strictMax: number;
  softMin: number;
  softMax: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toRange(centerBp: number, bpPerPx: number, widthPx: number): GenomicRange {
  const span = Math.max(1, bpPerPx * Math.max(1, widthPx));
  const start = centerBp - span / 2;
  const end = centerBp + span / 2;
  return { start, end, span };
}

export function getCenterBounds(
  chrLength: number,
  bpPerPx: number,
  widthPx: number,
  overscrollRatio = 0.25,
): CenterBounds {
  const span = Math.max(1, bpPerPx * Math.max(1, widthPx));

  if (span >= chrLength) {
    const center = chrLength / 2;
    const margin = span * overscrollRatio;
    return {
      strictMin: center,
      strictMax: center,
      softMin: center - margin,
      softMax: center + margin,
    };
  }

  const strictMin = span / 2;
  const strictMax = chrLength - span / 2;
  const margin = span * overscrollRatio;

  return {
    strictMin,
    strictMax,
    softMin: strictMin - margin,
    softMax: strictMax + margin,
  };
}

export function formatBp(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  return rounded.toLocaleString('en-US');
}

/**
 * Coordinates have two lives here.
 *
 * Internally every position is 0-based and half-open, like BED and like the
 * bigWig, bigBed and UCSC sequence APIs this reads: the first base of a
 * chromosome is 0, and a range's end is one past its last base. That is what
 * arithmetic, caching and the model windows all speak.
 *
 * What a reader sees is 1-based inclusive, like the UCSC browser, Ensembl and
 * IGV: the first base is 1, and a range ends on its last base. The two differ by
 * one at the start, which is the difference between quoting a splice site and
 * quoting the base before it -- the browser used to show the internal number,
 * so a locus pasted from UCSC landed one base to the right.
 */
export function toDisplayPosition(position: number): number {
  return Math.round(position) + 1;
}

export function fromDisplayPosition(position: number): number {
  return Math.round(position) - 1;
}

/** One coordinate as a reader should see it. */
export function formatPosition(position: number): string {
  return formatBp(Math.max(1, toDisplayPosition(position)));
}

/** An internal half-open range as the inclusive one a reader expects. */
export function formatRange(start: number, end: number): string {
  const displayStart = Math.max(1, toDisplayPosition(start));
  const displayEnd = Math.max(displayStart, Math.round(end));
  return `${formatBp(displayStart)}-${formatBp(displayEnd)}`;
}

/** "chr7:5,527,152-5,530,601" from internal coordinates. */
export function formatLocus(chr: string, start: number, end: number): string {
  return `${chr}:${formatRange(start, end)}`;
}

export function niceStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(step));
  const base = 10 ** exponent;
  const scaled = step / base;

  if (scaled <= 1) {
    return base;
  }
  if (scaled <= 2) {
    return 2 * base;
  }
  if (scaled <= 5) {
    return 5 * base;
  }
  return 10 * base;
}

export function clampRangeToChromosome(
  range: GenomicRange,
  chrLength: number,
): GenomicRange {
  if (range.span >= chrLength) {
    return { start: 0, end: chrLength, span: chrLength };
  }

  const start = clamp(range.start, 0, chrLength - range.span);
  const end = start + range.span;
  return { start, end, span: range.span };
}
