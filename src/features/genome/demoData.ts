import type { AssemblyId } from './types';

// Every demo track is read from UCSC over HTTP range requests rather than bundled.
// Two reasons:
//
// 1. Size. The signal files are 200-450 MB. They were gitignored, which meant CI
//    and any clean checkout silently rendered empty tracks, and no static host
//    takes them anyway -- Cloudflare Pages caps a single file at 25 MiB. bigWig
//    only pulls the header, the zoom index, and the blocks in view, so reading a
//    450 MB file remotely costs tens of KB per screen.
//
// 2. Assembly. The files previously bundled under public/data/ucsc were the hg19
//    builds (verified from their own headers: chr1 = 249,250,621, and
//    bigNarrowPeak.bb carried chr2 = 243,199,373). The browser defaults to hg38
//    and every sequence model in the catalog requires hg38, so those tracks were
//    being drawn against the wrong coordinate system. The URLs below are the hg38
//    builds of the same GM12878 experiments -- each one checked to report
//    chr1 = 248,956,422 and to serve `Access-Control-Allow-Origin: *` with
//    `Access-Control-Allow-Headers: Range`.
//
// Keep DEMO_ASSEMBLY_ID and these URLs in step: the app's default assembly is
// derived from DEMO_ASSEMBLY_ID precisely so the two cannot drift apart again.
export const DEMO_ASSEMBLY_ID: AssemblyId = 'hg38';

const UCSC_GBDB_HG38 = 'https://hgdownload.soe.ucsc.edu/gbdb/hg38';
const ENCODE_REG = `${UCSC_GBDB_HG38}/bbi/wgEncodeReg`;

export const DEMO_TRACK_URLS = {
  h3k27ac: `${ENCODE_REG}/wgEncodeRegMarkH3k27ac/wgEncodeBroadHistoneGm12878H3k27acStdSig.bigWig`,
  h3k4me3: `${ENCODE_REG}/wgEncodeRegMarkH3k4me3/wgEncodeBroadHistoneGm12878H3k4me3StdSig.bigWig`,
  h3k4me1: `${ENCODE_REG}/wgEncodeRegMarkH3k4me1/wgEncodeBroadHistoneGm12878H3k4me1StdSig.bigWig`,
  ccre: `${UCSC_GBDB_HG38}/encode3/ccre/encodeCcreCombined.bb`,
} as const;

/**
 * MANE Select on hg38: one transcript per gene, keyed by the same versioned
 * Ensembl ids GENCODE uses, which is what lets the annotation tell the
 * representative transcript from the alternates around it.
 */
export const MANE_SELECT_BIGBED_URL = 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/mane/mane.bb';

/** GENCODE V50 comprehensive transcripts on hg38 (~57 MB bigGenePred). Always remote. */
export const GENCODE_V50_BIGBED_URL =
  'https://hgdownload.soe.ucsc.edu/gbdb/hg38/gencode/gencodeV50.bb';

export function gencodeV50Url(): string {
  return GENCODE_V50_BIGBED_URL;
}

/**
 * One canonical transcript per gene, for a transcript model's N padding
 * (inference.transcriptPadding). MANE Select is the closest thing to the
 * canonical set a transcript model is trained on; assemblies without one get no padding.
 */
export function canonicalTranscriptAnnotationUrl(genome: string): string | undefined {
  return genome === 'hg38' ? MANE_SELECT_BIGBED_URL : undefined;
}
