import type { ReferenceSequenceWindow } from './signalSequenceDisplay';

/**
 * Name the dinucleotide a splice call is sitting on, and the strand it reads on.
 *
 * A model trained on strand-normalised genes has no reason to learn that an
 * antisense splice site is not a splice site: reverse-complement the motif and
 * its context and it looks exactly like the real thing. Fed a plus-strand
 * window, a splice model duly calls them, and a bar with no label gives the reader no
 * way to tell an antisense hit from a genuinely non-canonical one.
 *
 * So each call is read both ways. `GT +` is the textbook donor; `AC -` is the
 * same donor seen from the other strand; anything else is reported as-is, which
 * is the answer to "why is this not GT?".
 */

export type SpliceSiteKind = 'donor' | 'acceptor';

export type SpliceMotif = {
  dinucleotide: string;
  /** `null` when the call matches neither canonical form on either strand. */
  strand: '+' | '-' | null;
};

/**
 * Where the dinucleotide sits, and what it reads as.
 *
 *   donor     exon | GT ...     the two bases 3' of the call
 *   donor (-) ... AC | exon     the same site on the minus strand, so 5'
 *   acceptor  ... AG | exon     the two bases 5' of the call
 *   acceptor (-)  exon | CT ... the same site on the minus strand, so 3'
 *
 * The two kinds are mirror images of each other, which is what makes a strand
 * mix-up so easy to mistake for a non-canonical site.
 */
const CANONICAL: Record<SpliceSiteKind, { plus: string; minus: string }> = {
  donor: { plus: 'GT', minus: 'AC' },
  acceptor: { plus: 'AG', minus: 'CT' },
};

/**
 * Which site a series reports. Packs name their channels rather than typing
 * them, so the name is what there is to go on; an unrecognised name simply gets
 * no motif rather than a guessed one.
 */
export function spliceSiteKindFromName(...names: readonly (string | undefined)[]): SpliceSiteKind | null {
  for (const name of names) {
    const lower = name?.toLowerCase();
    if (!lower) {
      continue;
    }
    if (lower.includes('donor')) {
      return 'donor';
    }
    if (lower.includes('acceptor')) {
      return 'acceptor';
    }
  }
  return null;
}

function dinucleotideAt(reference: ReferenceSequenceWindow, from: number): string | null {
  const offset = from - reference.start;
  if (offset < 0 || offset + 2 > reference.sequence.length) {
    return null;
  }
  const pair = reference.sequence.slice(offset, offset + 2).toUpperCase();
  return /^[ACGT]{2}$/.test(pair) ? pair : null;
}

/**
 * @param position genomic coordinate of the called base, in the same space as
 *   `reference.start` -- the last exonic base for a donor, the first for an
 *   acceptor.
 */
export function readSpliceMotif(
  reference: ReferenceSequenceWindow,
  position: number,
  kind: SpliceSiteKind,
): SpliceMotif | null {
  if (reference.sequence.length === 0) {
    return null;
  }

  const upstream = position - 2;
  const downstream = position + 1;
  const canonical = CANONICAL[kind];
  const plus = dinucleotideAt(reference, kind === 'donor' ? downstream : upstream);
  const minus = dinucleotideAt(reference, kind === 'donor' ? upstream : downstream);

  if (plus === canonical.plus) {
    return { dinucleotide: plus, strand: '+' };
  }
  if (minus === canonical.minus) {
    return { dinucleotide: minus, strand: '-' };
  }
  // Neither form matched. The plus-strand slot is the one the reader is asking
  // about when they ask why a call is not GT/AG, so that is what gets reported.
  return plus === null ? null : { dinucleotide: plus, strand: null };
}

/**
 * `GT +`, `AC -`, or `TG ?` for a call that matches neither canonical form on
 * either strand -- the question mark being the strand, which there isn't one of.
 */
export function formatSpliceMotif(motif: SpliceMotif): string {
  if (motif.strand === null) {
    return `${motif.dinucleotide} ?`;
  }
  return `${motif.dinucleotide} ${motif.strand === '+' ? '+' : '−'}`;
}

/**
 * Whether a call belongs on the strand the genes here actually run on.
 *
 * Fails open in both directions that matter. A call on neither canonical form
 * has no strand to contradict -- GC-AG and AT-AC introns live there, and so
 * does the model's noise floor -- and a coordinate no annotated gene covers has
 * nothing to be judged against. Where two genes overlap on opposite strands,
 * both readings are the sense reading.
 */
export function spliceCallSuitsGeneStrand(
  motif: SpliceMotif | null,
  geneStrands: readonly ('+' | '-')[],
): boolean {
  if (!motif || motif.strand === null || geneStrands.length === 0) {
    return true;
  }
  return geneStrands.includes(motif.strand);
}
