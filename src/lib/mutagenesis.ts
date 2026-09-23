/**
 * Exact in silico saturation mutagenesis, the pure parts.
 *
 * An attribution row declared with `mutagenesis` is not read from the graph. For
 * each base in the focus the worker re-scores the whole request window three
 * times, once per substitution, and the row's value at that base is the summed
 * absolute change in probability within `contextBp` of it, averaged over the
 * three substitutions. A base the calls depend on reads high; so does a base
 * whose mutation would create a call. The row is unsigned.
 *
 * Unsigned on purpose. A signed sum (reference minus mutant) was tried first
 * and inverted at the very bases that matter: destroying ACTB's exon-5 donor
 * drops that site by 1.0 but raises the candidate donors around it by 3.5 in
 * total, so the GT read negative. The absolute sum reads 2.6 there and 0.02
 * to 0.07 at background bases.
 *
 * Why not the gradient: a first-order Taylor estimate was tried before that
 * and read the GT of a locked-in donor at -0.3 where mutating it removes the
 * call. A saturated site has no useful gradient. Three forward passes per
 * base, batched, are affordable for the bases on one screen.
 *
 * Everything here is coordinate bookkeeping and arithmetic over typed arrays,
 * so it can be pinned by unit tests; the worker owns the session and the
 * batching.
 */

/**
 * Which output positions to mutate, in the model's own orientation.
 *
 * The focus is a genomic range. Output position `f` (forward orientation) maps
 * to genomic `coveredStart + f`, or through `genomicPositions` when the window
 * carries edits, in which case inserted bases (no coordinate) lying between two
 * selected positions are taken along: they are on screen too. On the minus
 * strand the model reads the reverse complement, so position `f` of the forward
 * output is position `outputLength - 1 - f` of what the model produced.
 */
export function mutagenesisOutputPositions(args: {
  focusStart: number;
  focusEnd: number;
  coveredStart: number;
  genomicPositions: readonly (number | null)[] | null;
  /** Output index 0 is this index of the (edited) model sequence. */
  interiorStart: number;
  outputLength: number;
  reverseComplement: boolean;
}): number[] {
  const { focusStart, focusEnd, coveredStart, genomicPositions, interiorStart, outputLength, reverseComplement } = args;
  const genomicOf = (f: number): number | null =>
    genomicPositions ? genomicPositions[interiorStart + f] ?? null : coveredStart + f;

  let first = -1;
  let last = -1;
  for (let f = 0; f < outputLength; f += 1) {
    const genomic = genomicOf(f);
    if (genomic === null || genomic < focusStart || genomic >= focusEnd) {
      continue;
    }
    if (first < 0) {
      first = f;
    }
    last = f;
  }
  if (first < 0) {
    return [];
  }

  const positions: number[] = [];
  for (let f = first; f <= last; f += 1) {
    const genomic = genomicOf(f);
    if (genomic !== null && (genomic < focusStart || genomic >= focusEnd)) {
      continue;
    }
    positions.push(reverseComplement ? outputLength - 1 - f : f);
  }
  positions.sort((a, b) => a - b);
  return positions;
}

/** The one-hot channel set at an input position, or -1 for N. Layout is [4, L]. */
export function referenceBaseIndex(encoded: Float32Array, seqLength: number, inputIndex: number): number {
  for (let base = 0; base < 4; base += 1) {
    if ((encoded[base * seqLength + inputIndex] ?? 0) > 0.5) {
      return base;
    }
  }
  return -1;
}

/**
 * Write one mutant into a [B, 4, L] batch: the reference one-hot with a single
 * position switched from `refBase` to `altBase`.
 */
export function writeMutant(
  batch: Float32Array,
  batchOffset: number,
  encoded: Float32Array,
  seqLength: number,
  inputIndex: number,
  refBase: number,
  altBase: number,
): void {
  batch.set(encoded, batchOffset);
  batch[batchOffset + refBase * seqLength + inputIndex] = 0;
  batch[batchOffset + altBase * seqLength + inputIndex] = 1;
}

/**
 * Sum, over the output positions within `contextBp` of the mutated position,
 * of |p(mutant) - p(reference)| for one channel. `output` is the mutant batch's
 * prediction, [B, C, L], with `offset` addressing one (mutant, channel) row;
 * `reference` is the reference prediction, [C, L], with `referenceOffset`
 * addressing the channel.
 */
export function mutantAbsoluteChange(
  output: Float32Array,
  offset: number,
  reference: Float32Array,
  referenceOffset: number,
  position: number,
  contextBp: number,
  outputLength: number,
): number {
  const from = Math.max(0, position - contextBp);
  const to = Math.min(outputLength - 1, position + contextBp);
  let sum = 0;
  for (let index = from; index <= to; index += 1) {
    sum += Math.abs((output[offset + index] ?? 0) - (reference[referenceOffset + index] ?? 0));
  }
  return sum;
}

/**
 * The largest change the mean of a base's three mutants made to one channel's
 * prediction: where, in bases from the mutated base along the strand the model
 * read (+ is downstream, which is to the right on screen on either strand; 0 is
 * the base itself), and from what probability to what. Stored as an offset, not
 * an output index, because the per-base cache outlives the window it was
 * computed in.
 */
export type MutantEffect = {
  offset: number;
  reference: number;
  mutant: number;
};

/** Where, over `length` positions, `values` differs most from `reference`, and both values there. */
export function largestChange(
  values: ArrayLike<number>,
  valuesOffset: number,
  reference: ArrayLike<number>,
  referenceOffset: number,
  length: number,
): { index: number; reference: number; value: number } {
  let best = { index: 0, reference: reference[referenceOffset] ?? 0, value: values[valuesOffset] ?? 0 };
  let bestChange = -1;
  for (let index = 0; index < length; index += 1) {
    const value = values[valuesOffset + index] ?? 0;
    const ref = reference[referenceOffset + index] ?? 0;
    const change = Math.abs(value - ref);
    if (change > bestChange) {
      bestChange = change;
      best = { index, reference: ref, value };
    }
  }
  return best;
}

/** The mean of several rows of `output` (each starting at its offset), over `length` positions from `from`. */
export function averageRows(
  output: ArrayLike<number>,
  rowOffsets: readonly number[],
  from: number,
  length: number,
): Float32Array {
  const out = new Float32Array(length);
  if (rowOffsets.length === 0) {
    return out;
  }
  for (const rowOffset of rowOffsets) {
    for (let index = 0; index < length; index += 1) {
      out[index] += output[rowOffset + from + index] ?? 0;
    }
  }
  for (let index = 0; index < length; index += 1) {
    out[index] /= rowOffsets.length;
  }
  return out;
}

/** The row's value: the mean over the substitutions of their summed absolute change. */
export function mutagenesisValue(summedChanges: number, substitutionCount = 3): number {
  return substitutionCount > 0 ? summedChanges / substitutionCount : 0;
}

/**
 * What the mean of a scored base's three mutants predicts around it, kept for
 * the hover: every channel, clipped to the context, in display (forward) order,
 * with each position's column -- a genomic base, or an inserted base named by
 * the coordinate its run sits in front of and its place in the run -- so an
 * edited window is the same kind of record as a reference one. Probabilities
 * quantised to 16 bits (a quantum of 1.5e-5, far below anything a plot shows):
 * about 14 KB a base for a two-channel model.
 */
export type MutantCurveRecord = {
  /** The mutated base as the model read it: the letter shown on the strand being read. */
  refBase: string;
  /** The substitutions averaged, as read. */
  alts: string;
  length: number;
  channelCount: number;
  /** Genomic coordinate of each position; for an inserted base, the coordinate its run precedes. */
  anchors: Int32Array;
  /** -1 for a genomic base; otherwise the inserted base's place in its run. */
  insertOffsets: Int16Array;
  /** [C x length], quantised. */
  reference: Uint16Array;
  /** [C x length], quantised: the mean of the three mutants. */
  mean: Uint16Array;
};

export type MutantOverlayData = {
  position: number;
  refBase: string;
  alts: string;
  length: number;
  channelCount: number;
  anchors: Int32Array;
  insertOffsets: Int16Array;
  /** [C x length]. */
  reference: Float32Array;
  /** [C x length]. */
  mean: Float32Array;
};

/**
 * Probabilities are kept as 16-bit codes of their log-odds, clamped to ±17.
 *
 * A linear code steps by 1.5e-5: fine on a linear axis, ruinous on a
 * −log(1−p) one. A confident site at 0.9999999 stored that way came back
 * anywhere from 0.99998 to 1, so the hover overlay drew every such site about
 * two nines away from where its own row drew it. A log-odds step is a fixed
 * relative change of p near 0 and of 1 − p near 1 (5e-4 of it), and at worst
 * 1.3e-4 in p mid-range. ±17 is where float32 stops telling p from 0 or 1; the
 * end codes decode to exactly 0 and 1.
 */
const CODE_MAX = 65535;
const LOGIT_LIMIT = 17;

export function quantizeUnit(values: ArrayLike<number>, out: Uint16Array, offset: number): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    let code = 0;
    if (value >= 1) {
      code = CODE_MAX;
    } else if (value > 0) {
      const logit = Math.min(LOGIT_LIMIT, Math.max(-LOGIT_LIMIT, Math.log(value / (1 - value))));
      code = Math.round(((logit + LOGIT_LIMIT) / (2 * LOGIT_LIMIT)) * CODE_MAX);
    }
    out[offset + index] = code;
  }
}

export function dequantizeUnit(values: Uint16Array, from: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const code = values[from + index] ?? 0;
    if (code <= 0) {
      out[index] = 0;
    } else if (code >= CODE_MAX) {
      out[index] = 1;
    } else {
      const logit = (code / CODE_MAX) * 2 * LOGIT_LIMIT - LOGIT_LIMIT;
      out[index] = 1 / (1 + Math.exp(-logit));
    }
  }
  return out;
}

export function mutantCurveBytes(record: MutantCurveRecord): number {
  return (
    record.reference.byteLength +
    record.mean.byteLength +
    record.anchors.byteLength +
    record.insertOffsets.byteLength +
    96
  );
}

/**
 * The column of every output position of a window, in forward order: its
 * genomic coordinate, or for an inserted base the coordinate its run sits in
 * front of and its place in the run. The same rule `extractInsertedScores`
 * uses to place inserted bases' scores, so an overlay lands in the columns the
 * row drew. Without edits every position is `coveredStart + f`.
 */
export function forwardAnchors(
  genomicPositions: readonly (number | null)[] | null,
  interiorStart: number,
  outputLength: number,
  coveredStart: number,
): { anchors: Int32Array; insertOffsets: Int16Array } {
  const anchors = new Int32Array(outputLength);
  const insertOffsets = new Int16Array(outputLength).fill(-1);
  if (!genomicPositions) {
    for (let f = 0; f < outputLength; f += 1) {
      anchors[f] = coveredStart + f;
    }
    return { anchors, insertOffsets };
  }
  const assign = (index: number, anchor: number, offset: number) => {
    const f = index - interiorStart;
    if (f >= 0 && f < outputLength) {
      anchors[f] = anchor;
      insertOffsets[f] = offset;
    }
  };
  let pending: number[] = [];
  let lastGenomic = coveredStart - 1;
  for (let index = 0; index < genomicPositions.length; index += 1) {
    const genomic = genomicPositions[index];
    if (genomic === null || genomic === undefined) {
      pending.push(index);
      continue;
    }
    pending.forEach((inserted, offset) => assign(inserted, genomic, offset));
    pending = [];
    assign(index, genomic, -1);
    lastGenomic = genomic;
  }
  // A run at the very end has no base after it: it sits in front of the next coordinate.
  pending.forEach((inserted, offset) => assign(inserted, lastGenomic + 1, offset));
  return { anchors, insertOffsets };
}

/** Find a column in an overlay: a genomic base by coordinate, an inserted base by (before, offset). */
export function mutantOverlayIndex(
  data: Pick<MutantOverlayData, 'anchors' | 'insertOffsets' | 'length'>,
): (genomic: number, insertionOffset?: number) => number {
  const bases = new Map<number, number>();
  const inserted = new Map<string, number>();
  for (let index = 0; index < data.length; index += 1) {
    const offset = data.insertOffsets[index] ?? -1;
    const anchor = data.anchors[index] ?? 0;
    if (offset < 0) {
      bases.set(anchor, index);
    } else {
      inserted.set(`${anchor}:${offset}`, index);
    }
  }
  return (genomic, insertionOffset) =>
    insertionOffset === undefined
      ? bases.get(genomic) ?? -1
      : inserted.get(`${genomic}:${insertionOffset}`) ?? -1;
}

export function mutantRecordToOverlay(record: MutantCurveRecord, position: number): MutantOverlayData {
  const size = record.channelCount * record.length;
  return {
    position,
    refBase: record.refBase,
    alts: record.alts,
    length: record.length,
    channelCount: record.channelCount,
    anchors: record.anchors,
    insertOffsets: record.insertOffsets,
    reference: dequantizeUnit(record.reference, 0, size),
    mean: dequantizeUnit(record.mean, 0, size),
  };
}
