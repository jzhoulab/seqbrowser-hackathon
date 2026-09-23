import type { Chromosome, IdeogramBand } from '../types';

export type GenomeAssemblyId = 'hg19' | 'hg38' | 'mm10' | 'mm39';

type AssemblySignature = {
  id: GenomeAssemblyId;
  lengths: Record<string, number>;
};

type IdeogramPayload = {
  assembly: GenomeAssemblyId;
  bandsByChr: Record<string, IdeogramBand[]>;
};

const IDEOGRAM_ASSEMBLY_SIGNATURES: AssemblySignature[] = [
  {
    id: 'hg19',
    lengths: {
      chr1: 249_250_621,
      chrX: 155_270_560,
    },
  },
  {
    id: 'hg38',
    lengths: {
      chr1: 248_956_422,
      chrX: 156_040_895,
    },
  },
  {
    id: 'mm10',
    lengths: {
      chr1: 195_471_971,
      chrX: 171_031_299,
    },
  },
  {
    id: 'mm39',
    lengths: {
      chr1: 195_154_279,
      chrX: 169_476_592,
    },
  },
];

const ideogramCache = new Map<GenomeAssemblyId, Promise<Record<string, IdeogramBand[]>>>();

export function detectGenomeAssembly(chromosomes: Chromosome[]): GenomeAssemblyId | null {
  if (chromosomes.length === 0) {
    return null;
  }

  const lengthByChr = new Map<string, number>();
  for (const chromosome of chromosomes) {
    lengthByChr.set(chromosome.id, chromosome.length);
  }

  for (const signature of IDEOGRAM_ASSEMBLY_SIGNATURES) {
    let requiredCount = 0;
    let matchedCount = 0;
    let missingRequired = false;

    for (const [chr, expectedLength] of Object.entries(signature.lengths)) {
      const actualLength = lengthByChr.get(chr);
      if (actualLength == null) {
        missingRequired = true;
        break;
      }
      requiredCount += 1;
      if (actualLength === expectedLength) {
        matchedCount += 1;
      }
    }

    if (!missingRequired && requiredCount > 0 && matchedCount === requiredCount) {
      return signature.id;
    }
  }

  return null;
}

export async function loadIdeogramBands(
  assembly: GenomeAssemblyId,
): Promise<Record<string, IdeogramBand[]>> {
  const cached = ideogramCache.get(assembly);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const response = await fetch(`/data/ideograms/${assembly}.cytoband.json`);
    if (!response.ok) {
      throw new Error(`Unable to load ideogram data for ${assembly}`);
    }

    const payload = (await response.json()) as IdeogramPayload;
    return payload.bandsByChr ?? {};
  })();

  ideogramCache.set(assembly, request);
  return request;
}
