import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearLocalGeneIndexCache,
  loadLocalGeneIndex,
  parseGeneTable,
} from '../data/localGeneIndex';

const TABLE = [
  '# symbol\tchr\tstart\tlength\thg38\t4',
  'ACTB\tchr7\t5527147\t3454',
  'BRCA1\tchr17\t43044294\t81070',
  'BRCA2\tchr13\t32315085\t85183',
  'TP53\tchr17\t7668420\t19070',
].join('\n');

describe('shipped gene table', () => {
  afterEach(() => {
    clearLocalGeneIndexCache();
    vi.unstubAllGlobals();
  });

  it('parses symbol, chromosome and span, skipping the header', () => {
    const entries = parseGeneTable(TABLE);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ symbol: 'ACTB', chr: 'chr7', start: 5_527_147, end: 5_530_601 });
  });

  it('ignores malformed rows rather than failing the whole table', () => {
    const entries = parseGeneTable(
      ['GOOD\tchr1\t100\t50', 'BAD\tchr1\tnot-a-number\t50', '\tchr1\t1\t1', 'ZERO\tchr1\t10\t0'].join('\n'),
    );

    expect(entries.map((entry) => entry.symbol)).toEqual(['GOOD']);
  });

  it('fetches the table for an assembly and indexes it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => TABLE });
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await loadLocalGeneIndex('hg38');

    expect(fetchMock).toHaveBeenCalledWith('/data/genes/hg38.genes.tsv');
    expect(loaded?.size).toBe(4);
    expect(loaded?.index.findExact('tp53')).toMatchObject({ chr: 'chr17', start: 7_668_420 });
    expect(loaded?.index.findPrefix('BRCA').map((gene) => gene.symbol)).toEqual(['BRCA1', 'BRCA2']);
  });

  it('fetches once per assembly however many searches follow', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => TABLE });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([
      loadLocalGeneIndex('hg38'),
      loadLocalGeneIndex('hg38'),
      loadLocalGeneIndex('hg38'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an assembly with no shipped table as a miss, and remembers it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    expect(await loadLocalGeneIndex('mm39')).toBeNull();
    expect(await loadLocalGeneIndex('mm39')).toBeNull();
    // A search per keystroke must not become a 404 per keystroke.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a miss when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await loadLocalGeneIndex('hg38')).toBeNull();
  });

  it('treats an empty table as no table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '# header only\n' }));

    expect(await loadLocalGeneIndex('hg38')).toBeNull();
  });
});
