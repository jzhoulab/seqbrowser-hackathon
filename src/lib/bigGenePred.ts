/**
 * The gene symbol behind a bigGenePred row.
 *
 * A bigBed row's first nine columns are BED12 (name, score, strand, thick
 * start/end, colour, exon count, sizes, starts); a bigGenePred carries eleven
 * more, and the symbol a reader wants is among them: `geneName` (UCSC's GENCODE
 * files put the symbol there and a UCSC id in `name2`) or `name2` (files made
 * with genePredToBigGenePred put the symbol there). The transcript id stays in
 * `name`; the label a person reads is the gene.
 *
 * `extra` is everything after the ninth column, so `extra[0]` is `name2` and
 * `extra[5]` is `geneName`.
 */
const NAME2 = 0;
const GENE_NAME = 5;

const NOT_A_SYMBOL = /^(none|\.|)$|^uc[0-9a-z]+\.\d+$|^ENS[GT]\d+/i;

export function geneSymbolFromBigGenePred(name: string | undefined, extra: readonly string[] | undefined): string | undefined {
  if (!extra || extra.length === 0) {
    return undefined;
  }
  for (const candidate of [extra[GENE_NAME], extra[NAME2]]) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed !== name && !NOT_A_SYMBOL.test(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}
