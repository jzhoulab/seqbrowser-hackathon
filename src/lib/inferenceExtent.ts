export type CoveredExtentInput = {
  /** Start of the sequence actually fed to the model, including flanks. */
  sequenceStart: number;
  /** Length of the sequence actually fed to the model. May be shorter than asked. */
  sequenceLength: number;
  /** Context bases the pack declares the model consumes on each side. */
  flankBp: number;
  /** Window the caller asked about, excluding flanks. */
  requestStart: number;
  requestEnd: number;
};

export type CoveredExtent = {
  coveredStart: number;
  coveredEnd: number;
};

/**
 * Work out which genomic interval a model's output samples actually span.
 *
 * `flankBp` is defined as context the model consumes but does not emit output
 * for, so the covered interval is always the fed sequence minus one flank at each
 * end. That holds whether the model emits one sample per base or downsamples.
 *
 * The reason this is computed from the *fetched* sequence rather than the
 * requested window is clipping: near a chromosome start there may be fewer than
 * `flankBp` bases available on the left, and near the end the provider may return
 * a short sequence. In both cases the output covers less than was requested, and
 * mapping it onto the full requested window would stretch the signal — the signal
 * still looks plausible, just drawn in the wrong place.
 */
export function deriveCoveredExtent({
  sequenceStart,
  sequenceLength,
  flankBp,
  requestStart,
  requestEnd,
}: CoveredExtentInput): CoveredExtent {
  const flank = Math.max(0, flankBp);
  const coveredStart = sequenceStart + flank;
  const coveredEnd = sequenceStart + Math.max(0, sequenceLength) - flank;

  // A degenerate window (sequence shorter than its own flanks) has nothing to map.
  if (!Number.isFinite(coveredStart) || !Number.isFinite(coveredEnd) || coveredEnd <= coveredStart) {
    return { coveredStart: requestStart, coveredEnd: requestEnd };
  }

  return { coveredStart, coveredEnd };
}
