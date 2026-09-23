import { describe, expect, it } from 'vitest';

import {
  clampLocusToChromosome,
  switchAssemblyState,
} from '../features/genome/switching';

describe('CZ-002 Genome switch flow logic', () => {
  it('switching assembly updates available chromosome set', () => {
    const cases = [
      {
        name: 'filters invalid lengths and sorts chromosomes deterministically',
        nextChromSizes: {
          chr2: 120,
          chrM: 16,
          chr1: 240,
          chrX: 150,
          chr0: 0,
          chrBad: -5,
        },
        expectedChromosomes: ['chr1', 'chr2', 'chrX', 'chrM'],
      },
      {
        name: 'supports non-numeric chromosomes with stable lexical tail order',
        nextChromSizes: {
          chr10: 90,
          chrUn: 12,
          chr2: 80,
          chrGL0001: 5,
        },
        expectedChromosomes: ['chr2', 'chr10', 'chrGL0001', 'chrUn'],
      },
    ] as const;

    for (const testCase of cases) {
      const next = switchAssemblyState({
        nextChromSizes: testCase.nextChromSizes,
        selectedChr: 'chr1',
        locus: { start: 10, end: 20 },
      });

      expect(next.chromosomes, testCase.name).toEqual(testCase.expectedChromosomes);
    }
  });

  it('invalid selected chr falls back safely', () => {
    const cases = [
      {
        name: 'falls back to chr1 when selected chr is not present',
        selectedChr: 'chr9',
        nextChromSizes: { chr2: 220, chr1: 250, chrX: 160 },
        expectedChr: 'chr1',
      },
      {
        name: 'falls back to sorted first chromosome when chr1 is absent',
        selectedChr: 'chr9',
        nextChromSizes: { chr3: 180, chr2: 200 },
        expectedChr: 'chr2',
      },
      {
        name: 'keeps selected chromosome when it exists case-insensitively',
        selectedChr: 'CHRX',
        nextChromSizes: { chr1: 10, chrX: 20 },
        expectedChr: 'chrX',
      },
    ] as const;

    for (const testCase of cases) {
      const next = switchAssemblyState({
        nextChromSizes: testCase.nextChromSizes,
        selectedChr: testCase.selectedChr,
        locus: { start: 4, end: 12 },
      });

      expect(next.selectedChr, testCase.name).toBe(testCase.expectedChr);
    }
  });

  it('locus clamp to new chr bounds', () => {
    const cases = [
      {
        name: 'keeps in-bounds locus unchanged',
        locus: { start: 10, end: 30 },
        chrLength: 100,
        expected: { start: 10, end: 30 },
      },
      {
        name: 'shifts overflowing locus to preserve span inside chromosome',
        locus: { start: 90, end: 130 },
        chrLength: 100,
        expected: { start: 60, end: 100 },
      },
      {
        name: 'clamps negative locus to chromosome start',
        locus: { start: -20, end: 10 },
        chrLength: 100,
        expected: { start: 0, end: 30 },
      },
      {
        name: 'returns full chromosome when span is larger than chromosome',
        locus: { start: 0, end: 150 },
        chrLength: 100,
        expected: { start: 0, end: 100 },
      },
    ] as const;

    for (const testCase of cases) {
      const next = clampLocusToChromosome(testCase.locus, testCase.chrLength);
      expect(next, testCase.name).toEqual(testCase.expected);
    }
  });
});
