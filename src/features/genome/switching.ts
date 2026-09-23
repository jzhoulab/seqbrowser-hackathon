export type ChromSizes = Record<string, number>;

export type GenomeLocus = {
  start: number;
  end: number;
};

export type AssemblySwitchInput = {
  nextChromSizes: ChromSizes;
  selectedChr: string;
  locus: GenomeLocus;
};

export type AssemblySwitchResult = {
  chromosomes: string[];
  selectedChr: string;
  locus: GenomeLocus;
};

type ChromosomeSortKey = {
  bucket: number;
  numeric: number;
  text: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chromosomeSortKey(chr: string): ChromosomeSortKey {
  const body = chr.toLowerCase().startsWith('chr') ? chr.slice(3) : chr;
  const token = body.toUpperCase();

  if (/^\d+$/.test(token)) {
    return { bucket: 0, numeric: Number(token), text: '' };
  }

  if (token === 'X') {
    return { bucket: 1, numeric: 23, text: 'X' };
  }

  if (token === 'Y') {
    return { bucket: 1, numeric: 24, text: 'Y' };
  }

  if (token === 'M' || token === 'MT') {
    return { bucket: 1, numeric: 25, text: token };
  }

  return { bucket: 2, numeric: Number.POSITIVE_INFINITY, text: token };
}

function compareChromosomes(left: string, right: string): number {
  const leftKey = chromosomeSortKey(left);
  const rightKey = chromosomeSortKey(right);

  if (leftKey.bucket !== rightKey.bucket) {
    return leftKey.bucket - rightKey.bucket;
  }

  if (leftKey.numeric !== rightKey.numeric) {
    return leftKey.numeric - rightKey.numeric;
  }

  if (leftKey.text !== rightKey.text) {
    return leftKey.text < rightKey.text ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function toAvailableChromosomes(chromSizes: ChromSizes): string[] {
  return Object.entries(chromSizes)
    .filter(([, length]) => Number.isFinite(length) && length > 0)
    .map(([chr]) => chr)
    .sort(compareChromosomes);
}

export function resolveSelectedChromosome(selectedChr: string, chromosomes: string[]): string {
  if (chromosomes.length === 0) {
    return selectedChr;
  }

  if (chromosomes.includes(selectedChr)) {
    return selectedChr;
  }

  const selectedLower = selectedChr.toLowerCase();
  const caseInsensitiveMatch = chromosomes.find((chr) => chr.toLowerCase() === selectedLower);
  if (caseInsensitiveMatch) {
    return caseInsensitiveMatch;
  }

  if (chromosomes.includes('chr1')) {
    return 'chr1';
  }

  return chromosomes[0];
}

export function clampLocusToChromosome(locus: GenomeLocus, chromosomeLength: number): GenomeLocus {
  const safeLength =
    Number.isFinite(chromosomeLength) && chromosomeLength > 0 ? chromosomeLength : 1;

  const rawStart = Number.isFinite(locus.start) ? locus.start : 0;
  const rawEnd = Number.isFinite(locus.end) ? locus.end : rawStart + 1;
  const orderedStart = Math.min(rawStart, rawEnd);
  const orderedEnd = Math.max(rawStart, rawEnd);
  const span = Math.max(1, orderedEnd - orderedStart);

  if (span >= safeLength) {
    return { start: 0, end: safeLength };
  }

  const start = clamp(orderedStart, 0, safeLength - span);
  return { start, end: start + span };
}

export function switchAssemblyState(input: AssemblySwitchInput): AssemblySwitchResult {
  const chromosomes = toAvailableChromosomes(input.nextChromSizes);
  if (chromosomes.length === 0) {
    return {
      chromosomes,
      selectedChr: input.selectedChr,
      locus: { start: 0, end: 1 },
    };
  }

  const selectedChr = resolveSelectedChromosome(input.selectedChr, chromosomes);
  const chrLength = input.nextChromSizes[selectedChr];

  return {
    chromosomes,
    selectedChr,
    locus: clampLocusToChromosome(input.locus, chrLength),
  };
}
