import { describe, expect, it } from 'vitest';
import { DEMO_ASSEMBLY_ID, DEMO_TRACK_URLS } from '../features/genome/demoData';
import { getAssembly } from '../features/genome/registry';

// These are the chromosome lengths the hg38 demo files report in their own bigWig
// headers, read off the real files. If a demo URL is ever swapped for an hg19
// build again, DEMO_ASSEMBLY_ID stops describing the data and this pins the claim.
const HG38_CHR1 = 248956422;
const HG19_CHR1 = 249250621;

describe('demo track data', () => {
  it('names an assembly the registry actually knows', () => {
    expect(getAssembly(DEMO_ASSEMBLY_ID)).toBeDefined();
  });

  it('is hg38, matching the sequence models in the catalog', () => {
    expect(DEMO_ASSEMBLY_ID).toBe('hg38');
    expect(getAssembly(DEMO_ASSEMBLY_ID)?.chromSizes.chr1).toBe(HG38_CHR1);
    expect(getAssembly(DEMO_ASSEMBLY_ID)?.chromSizes.chr1).not.toBe(HG19_CHR1);
  });

  it('reads every demo track from an hg38 UCSC path', () => {
    for (const url of Object.values(DEMO_TRACK_URLS)) {
      expect(url).toMatch(/^https:\/\/hgdownload\.soe\.ucsc\.edu\/gbdb\/hg38\//);
      // The hg19 ENCODE mirror lives under goldenPath/hg19 -- never mix them in.
      expect(url).not.toContain('/hg19/');
    }
  });

  it('does not point at bundled files, which are gitignored and absent in CI', () => {
    for (const url of Object.values(DEMO_TRACK_URLS)) {
      expect(url.startsWith('/data/')).toBe(false);
    }
  });
});
