import { afterEach, describe, expect, it, vi } from 'vitest';

const { readBigBedDataMock, getHeaderMock } = vi.hoisted(() => ({
  readBigBedDataMock: vi.fn(),
  getHeaderMock: vi.fn(),
}));

vi.mock('../data/bbiReader', () => ({
  getReader: () => ({
    getHeader: getHeaderMock,
    readBigBedData: readBigBedDataMock,
    readZoomData: vi.fn().mockResolvedValue([]),
  }),
  readBigBedRows: (_reader: unknown, chr: string, start: number, end: number) => readBigBedDataMock(chr, start, chr, end),
  resolveSourceUrl: (url: string) => url,
}));

import { fetchTrackWindow } from '../data/bbiDataSource';
import { clearManeCache } from '../data/maneIndex';
import type { TrackSpec } from '../types';

const GENCODE_URL = 'https://example.test/gencode.bb';
const MANE_URL = 'https://example.test/mane.bb';

const TRANSCRIPTS = [
  { chr: 'chr7', start: 5_527_147, end: 5_530_601, name: 'ENST00000646664.1', strand: '-', exons: [] },
  { chr: 'chr7', start: 5_526_408, end: 5_530_601, name: 'ENST00000674681.1', strand: '-', exons: [] },
  { chr: 'chr7', start: 5_527_146, end: 5_529_949, name: 'ENST00000642480.2', strand: '-', exons: [] },
];

function gencodeTrack(maneUrl?: string): TrackSpec {
  return {
    id: 'gencode',
    name: 'GENCODE V50',
    color: '#e0575b',
    height: 96,
    kind: 'annotation',
    source: { type: 'bigbed', url: GENCODE_URL, maneUrl },
  };
}

const SPEC = { key: 'w', requestStart: 5_526_000, requestEnd: 5_531_000, resolutionBp: 1 };

describe('MANE emphasis on gene annotations', () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearManeCache();
  });

  function stubReads(maneRows: Array<{ name: string }>) {
    getHeaderMock.mockResolvedValue({ chromTree: { chromToId: { chr7: 0 } }, zoomLevelHeaders: [] });
    readBigBedDataMock.mockImplementation(async (chr: string) => {
      // The MANE fetch snaps to a coarse grid, so it asks for a wider window.
      const isManeRead = readBigBedDataMock.mock.calls.length > 1;
      void chr;
      return isManeRead ? maneRows : TRANSCRIPTS;
    });
  }

  it('marks the MANE transcript primary and the rest secondary', async () => {
    stubReads([{ name: 'ENST00000646664.1' }]);

    const features = await fetchTrackWindow(gencodeTrack(MANE_URL), 'chr7', SPEC);
    const byId = new Map(features.map((feature) => [feature.label, feature.emphasis]));

    expect(byId.get('ENST00000646664.1')).toBe('primary');
    expect(byId.get('ENST00000674681.1')).toBe('secondary');
    expect(byId.get('ENST00000642480.2')).toBe('secondary');
  });

  it('leaves every transcript unmarked when no companion track is configured', async () => {
    stubReads([]);

    const features = await fetchTrackWindow(gencodeTrack(), 'chr7', SPEC);

    expect(features.every((feature) => feature.emphasis === undefined)).toBe(true);
  });

  it('leaves transcripts unmarked when the MANE track answers with nothing', async () => {
    stubReads([]);

    const features = await fetchTrackWindow(gencodeTrack(MANE_URL), 'chr7', SPEC);

    expect(features.every((feature) => feature.emphasis === undefined)).toBe(true);
  });

  it('keeps drawing transcripts when the MANE track fails', async () => {
    getHeaderMock.mockResolvedValue({ chromTree: { chromToId: { chr7: 0 } }, zoomLevelHeaders: [] });
    readBigBedDataMock
      .mockResolvedValueOnce(TRANSCRIPTS)
      .mockRejectedValueOnce(new Error('404'));

    const features = await fetchTrackWindow(gencodeTrack(MANE_URL), 'chr7', SPEC);

    expect(features).toHaveLength(TRANSCRIPTS.length);
    expect(features.every((feature) => feature.emphasis === undefined)).toBe(true);
  });
});
