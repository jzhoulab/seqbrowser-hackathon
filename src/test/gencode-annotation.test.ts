import { describe, expect, it } from 'vitest';
import { mapBigBedRowToTrackFeature } from '../data/bbiDataSource';
import { GENCODE_V50_BIGBED_URL } from '../features/genome/demoData';

describe('GENCODE / bigGenePred annotation mapping', () => {
  it('preserves exon blocks and CDS bounds for transcript bodies', () => {
    const feature = mapBigBedRowToTrackFeature({
      start: 5_526_408,
      end: 5_530_601,
      name: 'ENST00000674681.1',
      score: 0,
      strand: '-',
      cdStart: 5_527_747,
      cdEnd: 5_529_657,
      exons: [
        { start: 5_526_408, end: 5_527_891 },
        { start: 5_528_003, end: 5_528_185 },
        { start: 5_528_280, end: 5_528_719 },
      ],
    });

    expect(feature.label).toBe('ENST00000674681.1');
    expect(feature.strand).toBe('-');
    expect(feature.exons).toHaveLength(3);
    expect(feature.cdsStart).toBe(5_527_747);
    expect(feature.cdsEnd).toBe(5_529_657);
    // Introns are implied by gaps between exons (not stored as intervals).
    expect(feature.exons![1].start - feature.exons![0].end).toBeGreaterThan(0);
  });

  it('points at the UCSC-hosted GENCODE V50 bigBed', () => {
    expect(GENCODE_V50_BIGBED_URL).toContain('gencodeV50.bb');
    expect(GENCODE_V50_BIGBED_URL).toContain('hg38');
  });
});
