import { afterEach, describe, expect, it, vi } from 'vitest';

import { rankGeneMatches } from '../features/search/geneMatches';
import { clearGeneSearchCache, searchGenes } from '../data/geneSearchSource';

/**
 * Trimmed from a real `api.genome.ucsc.edu/search?search=ACTB;genome=hg38`
 * response: the track mix, the HTML-escaped posNames, and the non-locus
 * positions are all reproduced as UCSC returns them.
 */
const ACTB_PAYLOAD = {
  positionMatches: [
    {
      trackName: 'mane',
      matches: [
        {
          position: 'chr7:5527148-5530601',
          posName: 'ACTB (NM_001101.5 &#x2F; ENST00000646664.1)',
          description: 'actin, cytoplasmic 1',
        },
        {
          position: 'chr5:57480018-57482811',
          posName: 'ACTBL2 (NM_001017992.4 &#x2F; ENST00000423391.3)',
          description: 'beta-actin-like protein 2',
        },
      ],
    },
    {
      trackName: 'hgnc',
      matches: [
        { position: 'chr7:5526409-5563902', posName: 'ACTB', description: 'actin beta' },
        { position: 'chrX:46288016-46289128', posName: 'ACTBP1', description: 'actin beta pseudogene 1' },
      ],
    },
    {
      trackName: 'knownGene',
      matches: [
        {
          position: 'chr7:5527148-5530601',
          posName: 'ACTB (ENST00000646664.1)',
          canonical: true,
          description: 'ACTB ENST00000646664.1 actin beta',
        },
        {
          // An alt contig the assembly registry has no entry for.
          position: 'chr7_KI270803v1_alt:1000-2000',
          posName: 'ACTB (ENST00000000000.1)',
          canonical: false,
        },
      ],
    },
    {
      trackName: 'mrna',
      matches: [
        { position: 'BC012854', posName: 'BC012854', description: 'Homo sapiens actin, beta, mRNA.' },
      ],
    },
    {
      trackName: 'publicHubs',
      matches: [{ position: 'https://epd.expasy.org/epd/ucsc/epdHub.txt:hg38:x', posName: 'EPD Viewer Hub' }],
    },
  ],
};

const PRIMARY_CHROMOSOMES = new Set(['chr5', 'chr7', 'chrX']);
const isKnownChromosome = (chr: string) => PRIMARY_CHROMOSOMES.has(chr);

describe('UCSC gene match ranking', () => {
  it('puts the exact symbol first and prefers the MANE span', () => {
    const matches = rankGeneMatches(ACTB_PAYLOAD, 'ACTB', { isKnownChromosome });

    expect(matches[0]).toMatchObject({
      symbol: 'ACTB',
      chr: 'chr7',
      // Internal: UCSC answered with the 1-based locus chr7:5,527,148-5,530,601.
      start: 5527147,
      end: 5530601,
      source: 'mane',
    });
  });

  it('matches symbols case-insensitively', () => {
    expect(rankGeneMatches(ACTB_PAYLOAD, 'actb', { isKnownChromosome })[0]?.symbol).toBe('ACTB');
  });

  it('collapses the same symbol reported by several tracks', () => {
    const symbols = rankGeneMatches(ACTB_PAYLOAD, 'ACTB', { isKnownChromosome }).map(
      (match) => match.symbol,
    );

    expect(symbols).toEqual(['ACTB', 'ACTBL2', 'ACTBP1']);
  });

  it('ranks prefix matches ahead of unrelated hits', () => {
    const matches = rankGeneMatches(ACTB_PAYLOAD, 'ACTBL2', { isKnownChromosome });

    expect(matches[0]?.symbol).toBe('ACTBL2');
  });

  it('drops accessions, hub URLs, and non-gene tracks', () => {
    const sources = new Set(
      rankGeneMatches(ACTB_PAYLOAD, 'ACTB', { isKnownChromosome }).map((match) => match.source),
    );

    expect(sources.has('mrna')).toBe(false);
    expect(sources.has('publicHubs')).toBe(false);
  });

  it('drops contigs the assembly registry does not carry', () => {
    const chromosomes = rankGeneMatches(ACTB_PAYLOAD, 'ACTB', { isKnownChromosome }).map(
      (match) => match.chr,
    );

    expect(chromosomes.every((chr) => isKnownChromosome(chr))).toBe(true);
  });

  it('decodes HTML entities out of posNames', () => {
    expect(rankGeneMatches(ACTB_PAYLOAD, 'ACTB', { isKnownChromosome })[0]?.symbol).not.toContain('&');
  });

  it('borrows a description when the winning row has none', () => {
    const withoutDescription = {
      positionMatches: [
        { trackName: 'mane', matches: [{ position: 'chr7:1-100', posName: 'ACTB (NM_1)' }] },
        { trackName: 'hgnc', matches: [{ position: 'chr7:1-200', posName: 'ACTB', description: 'actin beta' }] },
      ],
    };

    expect(rankGeneMatches(withoutDescription, 'ACTB', { isKnownChromosome })[0]?.description).toBe(
      'actin beta',
    );
  });

  it('hides description-only matches when a symbol matched', () => {
    const payload = {
      positionMatches: [
        {
          trackName: 'mane',
          matches: [
            { position: 'chr17:43044295-43125364', posName: 'BRCA1 (NM_007294.4)', description: 'BRCA1 DNA repair associated' },
            { position: 'chr11:108223067-108369102', posName: 'ATM (NM_000051.4)', description: 'phosphorylates BRCA1 and CHEK2' },
          ],
        },
      ],
    };

    expect(rankGeneMatches(payload, 'BRCA1').map((match) => match.symbol)).toEqual(['BRCA1']);
  });

  it('falls back to description matches when no symbol matched', () => {
    const payload = {
      positionMatches: [
        {
          trackName: 'mane',
          matches: [
            { position: 'chr11:108223067-108369102', posName: 'ATM (NM_000051.4)', description: 'ataxia telangiectasia mutated' },
          ],
        },
      ],
    };

    expect(rankGeneMatches(payload, 'telangiectasia').map((match) => match.symbol)).toEqual(['ATM']);
  });

  it('ignores knownGene annotation blobs as descriptions', () => {
    const payload = {
      positionMatches: [
        {
          trackName: 'knownGene',
          matches: [
            {
              position: 'chr11:108223067-108369102',
              posName: 'ATM (ENST00000675843.1)',
              canonical: true,
              description: 'ATM ENST00000675843.1 PubMed 21282113 Interacts with BRCA1 PubMed 17525340',
            },
          ],
        },
      ],
    };

    expect(rankGeneMatches(payload, 'ATM')[0]?.description).toBeUndefined();
  });

  it('honours the result limit', () => {
    expect(rankGeneMatches(ACTB_PAYLOAD, 'ACTB', { isKnownChromosome, limit: 2 })).toHaveLength(2);
  });

  it('returns nothing for an empty or unmatched payload', () => {
    expect(rankGeneMatches({}, 'ACTB')).toEqual([]);
    expect(rankGeneMatches(ACTB_PAYLOAD, '')).toEqual([]);
    expect(rankGeneMatches(null, 'ACTB')).toEqual([]);
  });
});

describe('gene search data source', () => {
  afterEach(() => {
    clearGeneSearchCache();
    vi.unstubAllGlobals();
  });

  it('queries UCSC with semicolon-separated parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ACTB_PAYLOAD });
    vi.stubGlobal('fetch', fetchMock);

    const matches = await searchGenes({ genome: 'hg38', term: 'ACTB', isKnownChromosome });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.genome.ucsc.edu/search?search=ACTB;genome=hg38',
    );
    expect(matches[0]?.symbol).toBe('ACTB');
  });

  it('serves a repeated term from cache instead of the network', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ACTB_PAYLOAD });
    vi.stubGlobal('fetch', fetchMock);

    await searchGenes({ genome: 'hg38', term: 'ACTB' });
    await searchGenes({ genome: 'hg38', term: 'actb ' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchGenes({ genome: 'hg38', term: 'ACTB' })).rejects.toThrow('503');
    await expect(searchGenes({ genome: 'hg38', term: 'ACTB' })).rejects.toThrow('503');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an aborted caller without cancelling the shared request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ACTB_PAYLOAD });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const aborted = searchGenes({ genome: 'hg38', term: 'ACTB', signal: controller.signal });
    controller.abort();

    await expect(aborted).rejects.toThrow(/aborted/i);
    await expect(searchGenes({ genome: 'hg38', term: 'ACTB' })).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the network for an empty term', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchGenes({ genome: 'hg38', term: '   ' })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
