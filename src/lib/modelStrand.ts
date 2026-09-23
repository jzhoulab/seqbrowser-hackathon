import type { TrackSpec } from '../types';
import { reverseComplement as reverseComplementSequence } from './displayAxis';

/**
 * A strand-specific model scores the strand on screen.
 *
 * Reading the minus strand reverse-complements the whole browser: the sequence
 * row, the ruler, the mirror on every data track. A model that scores one
 * orientation (a splice model is transcript-oriented: a donor reads GT at +1/+2) has to
 * see the reverse complement too, or a minus-strand gene is scored on the wrong
 * strand and merely drawn backwards. The worker flips the model's input and
 * un-flips its outputs, so everything downstream keeps working in genomic order
 * and a pack needs no strand handling of its own.
 */

/** Mark every computational source so the worker scores the displayed strand. */
export function orientTracksForStrand(tracks: readonly TrackSpec[], reverseComplement: boolean): TrackSpec[] {
  if (!reverseComplement) {
    return [...tracks];
  }
  return tracks.map((track) =>
    track.source.type === 'computational'
      ? { ...track, source: { ...track.source, reverseComplement: true } }
      : track,
  );
}

/** The sequence the model reads: as-is on the plus strand, its reverse complement on the minus. */
export function orientSequenceForModel(sequence: string, reverseComplement: boolean): string {
  return reverseComplement ? reverseComplementSequence(sequence) : sequence;
}

/**
 * A model output back into genomic order. Outputs are cropped by the same flank on
 * both sides, so reversing the cropped series is exactly the reverse of the input.
 */
export function restoreGenomicOrder(values: Float32Array, reverseComplement: boolean): Float32Array {
  return reverseComplement ? values.slice().reverse() : values;
}
