import { describe, expect, it } from 'vitest';

import {
  BUILTIN_ASSEMBLY_IDS,
  getAssembly,
  normalizeChromosomeName,
} from '../features/genome/registry';

describe('CZ-001 Assembly registry', () => {
  it('registers built-in assemblies', () => {
    expect(BUILTIN_ASSEMBLY_IDS).toEqual(['hg38', 'hg19', 'mm10']);

    for (const assemblyId of BUILTIN_ASSEMBLY_IDS) {
      expect(getAssembly(assemblyId)).toBeDefined();
    }
  });

  it('includes chromosome sizes for each built-in assembly', () => {
    for (const assemblyId of BUILTIN_ASSEMBLY_IDS) {
      const assembly = getAssembly(assemblyId);
      expect(assembly).toBeDefined();
      expect(assembly?.chromSizes.chr1).toBeGreaterThan(0);
      expect(assembly?.chromSizes.chrM).toBeGreaterThan(0);
    }
  });

  it('normalizes aliases to canonical chromosome names', () => {
    expect(normalizeChromosomeName('hg38', '1')).toBe('chr1');
    expect(normalizeChromosomeName('hg19', '1')).toBe('chr1');
    expect(normalizeChromosomeName('mm10', '1')).toBe('chr1');

    expect(normalizeChromosomeName('hg38', 'MT')).toBe('chrM');
    expect(normalizeChromosomeName('hg19', 'MT')).toBe('chrM');
    expect(normalizeChromosomeName('mm10', 'MT')).toBe('chrM');
  });
});
