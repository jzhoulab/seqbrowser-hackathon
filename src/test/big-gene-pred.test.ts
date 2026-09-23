import { describe, expect, it } from 'vitest';
import { mapBigBedRowToTrackFeature } from '../data/bbiDataSource';
import { geneSymbolFromBigGenePred } from '../lib/bigGenePred';

// The annotation track used to label every transcript with its ENST id, because
// the bigBed reader keeps nine columns and a bigGenePred's gene symbol is the
// eighteenth. A reader wants the gene; the transcript is a detail on hover.

// chr7:5,526,408-5,530,601 in UCSC's hg38 GENCODE V50 bigGenePred, columns past BED12.
const UCSC_GENCODE_EXTRA = ['uc288nsp.1', 'none', 'none', '0,1,0,0,0,-1,', 'none', 'ACTB', 'Q1KLZ0', 'protein_coding', 'coding', 'havana_homo_sapiens', 'protein_coding', 'CCDS,alternative_5_UTR', '2', 'basic,all', '9'];
// A file made with genePredToBigGenePred carries the symbol in name2 and nothing in geneName.
const GENEPRED_EXTRA = ['ACTB', 'cmpl', 'cmpl', '0,1,0,', 'none', 'none', 'none', 'none'];

describe('geneSymbolFromBigGenePred', () => {
  it("reads UCSC's geneName column, past the UCSC id in name2", () => {
    expect(geneSymbolFromBigGenePred('ENST00000674681.1', UCSC_GENCODE_EXTRA)).toBe('ACTB');
  });

  it('falls back to name2 when geneName is empty', () => {
    expect(geneSymbolFromBigGenePred('NM_001101.5', GENEPRED_EXTRA)).toBe('ACTB');
  });

  it('gives nothing for plain BED12, an id in place of a symbol, or the transcript name again', () => {
    expect(geneSymbolFromBigGenePred('ENST1', undefined)).toBeUndefined();
    expect(geneSymbolFromBigGenePred('ENST1', [])).toBeUndefined();
    expect(geneSymbolFromBigGenePred('ENST1', ['ENSG00000075624.17', 'none', 'none', '', 'none', 'none'])).toBeUndefined();
    expect(geneSymbolFromBigGenePred('ACTB', ['ACTB', 'none', 'none', '', 'none', 'ACTB'])).toBeUndefined();
  });
});

describe('mapBigBedRowToTrackFeature', () => {
  it('labels a transcript with its gene and keeps the transcript id', () => {
    const feature = mapBigBedRowToTrackFeature({ start: 5_526_408, end: 5_530_601, name: 'ENST00000674681.1', strand: '-', extra: UCSC_GENCODE_EXTRA });
    expect(feature.label).toBe('ACTB');
    expect(feature.transcriptId).toBe('ENST00000674681.1');
    expect(feature.strand).toBe('-');
  });

  it('labels a plain BED12 row with its name, as before', () => {
    const feature = mapBigBedRowToTrackFeature({ start: 10, end: 20, name: 'peak_1' });
    expect(feature.label).toBe('peak_1');
    expect(feature.transcriptId).toBeUndefined();
  });
});
