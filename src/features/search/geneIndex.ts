export interface GeneEntry {
  symbol: string;
  chr: string;
  start: number;
  end: number;
  /** Known for the shipped table; a jump opens the gene on this strand. */
  strand?: '+' | '-';
}

export interface GeneIndex {
  findExact(symbol: string): GeneEntry | null;
  findPrefix(prefix: string): GeneEntry[];
}

interface SearchableGene {
  key: string;
  gene: GeneEntry;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function createGeneIndex(genes: readonly GeneEntry[]): GeneIndex {
  const exactIndex = new Map<string, GeneEntry>();
  const prefixIndex: SearchableGene[] = [];

  for (const gene of genes) {
    const key = normalizeSymbol(gene.symbol);
    if (key.length === 0) {
      continue;
    }

    if (!exactIndex.has(key)) {
      exactIndex.set(key, gene);
    }
    prefixIndex.push({ key, gene });
  }

  return {
    findExact(symbol: string): GeneEntry | null {
      const key = normalizeSymbol(symbol);
      if (key.length === 0) {
        return null;
      }
      return exactIndex.get(key) ?? null;
    },

    findPrefix(prefix: string): GeneEntry[] {
      const key = normalizeSymbol(prefix);
      if (key.length === 0) {
        return [];
      }

      const matches: GeneEntry[] = [];
      for (const item of prefixIndex) {
        if (item.key.startsWith(key)) {
          matches.push(item.gene);
        }
      }
      return matches;
    },
  };
}
