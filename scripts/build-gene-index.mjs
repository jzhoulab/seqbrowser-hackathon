#!/usr/bin/env node
/**
 * Build the local gene-symbol index the locus box searches.
 *
 * UCSC's search endpoint answers a symbol with every track that matched -- 40+
 * of them, 200-540 KB, two to four seconds. That is a lot of waiting for a
 * question with a one-line answer, so the common case is served from a table
 * shipped with the app instead: symbol, chromosome, start, length.
 *
 * RefSeq Select is the source because it carries exactly one transcript per
 * gene, which is the span a reader wants to jump to. Genes it does not cover
 * (most pseudogenes and lncRNAs) still resolve through UCSC at runtime.
 *
 *   node scripts/build-gene-index.mjs [assembly...]
 */

import { createGunzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'public/data/genes');

/** Primary chromosomes only: the registry carries nothing else to jump to. */
const PRIMARY_CHROMOSOME = /^chr(?:\d+|X|Y|M)$/;

const SOURCES = {
  hg38: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/ncbiRefSeqSelect.txt.gz',
  hg19: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg19/database/ncbiRefSeqSelect.txt.gz',
  mm10: 'https://hgdownload.soe.ucsc.edu/goldenPath/mm10/database/ncbiRefSeqSelect.txt.gz',
};

/** genePred-ext columns, 1-based, as UCSC writes them. */
const COLUMN = { chrom: 2, strand: 3, txStart: 4, txEnd: 5, symbol: 12 };

async function readGenes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }

  const lines = createInterface({
    input: Readable.fromWeb(response.body).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  // One row per symbol: where a symbol appears more than once (PAR genes sit on
  // both sex chromosomes) the longest span wins, which is the locus a reader
  // means when they type the name.
  const bySymbol = new Map();
  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const columns = line.split('\t');
    const symbol = columns[COLUMN.symbol]?.trim();
    const chr = columns[COLUMN.chrom]?.trim();
    const start = Number(columns[COLUMN.txStart]);
    const end = Number(columns[COLUMN.txEnd]);
    // The strand a jump opens the gene on, so a transcript model reads it as trained.
    const rawStrand = columns[COLUMN.strand]?.trim();
    const strand = rawStrand === '+' || rawStrand === '-' ? rawStrand : undefined;

    if (!symbol || symbol === 'n/a' || !chr || !PRIMARY_CHROMOSOME.test(chr)) {
      continue;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }

    const existing = bySymbol.get(symbol);
    if (!existing || end - start > existing.end - existing.start) {
      bySymbol.set(symbol, { symbol, chr, start, end, strand });
    }
  }

  return [...bySymbol.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

async function build(assembly) {
  const url = SOURCES[assembly];
  if (!url) {
    throw new Error(`No source configured for "${assembly}".`);
  }

  const genes = await readGenes(url);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const outputPath = path.join(OUTPUT_DIR, `${assembly}.genes.tsv`);
  const stream = createWriteStream(outputPath);
  // Length rather than end: it is a shorter number, and the file is shipped.
  stream.write(`# symbol\tchr\tstart\tlength\tstrand\t${assembly}\t${genes.length}\n`);
  for (const gene of genes) {
    stream.write(`${gene.symbol}\t${gene.chr}\t${gene.start}\t${gene.end - gene.start}\t${gene.strand ?? ''}\n`);
  }
  await pipeline([], stream).catch(() => {});
  stream.end();

  return { assembly, count: genes.length, outputPath };
}

const requested = process.argv.slice(2);
const assemblies = requested.length > 0 ? requested : ['hg38'];

for (const assembly of assemblies) {
  const result = await build(assembly);
  console.log(`${result.assembly}: ${result.count.toLocaleString('en-US')} genes -> ${path.relative(REPO_ROOT, result.outputPath)}`);
}
