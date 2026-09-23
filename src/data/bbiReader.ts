import { BigWigReader, type BigBedData } from 'bigwig-reader';
import { BrowserRangeLoader } from './browserRangeLoader';

/**
 * One reader per resolved URL, shared by every consumer.
 *
 * A reader holds the file's header and index, so re-creating one per request
 * would re-read both before every range fetch.
 */
const readerCache = new Map<string, BigWigReader>();

export function resolveSourceUrl(rawUrl: string): string {
  if (typeof window === 'undefined') {
    return rawUrl;
  }
  return new URL(rawUrl, window.location.href).toString();
}

export function getReader(url: string): BigWigReader {
  const resolved = resolveSourceUrl(url);
  let reader = readerCache.get(resolved);
  if (!reader) {
    reader = new BigWigReader(new BrowserRangeLoader(resolved));
    readerCache.set(resolved, reader);
  }
  return reader;
}

/** A bigBed row with the columns past BED12 kept, as the strings they are. */
export type BigBedRow = BigBedData & { extra?: string[] };

type BigBedDecoder = (
  data: ArrayBuffer,
  filterStartChromIndex: number,
  filterStartBase: number,
  filterEndChromIndex: number,
  filterEndBase: number,
  chromDict: Record<number, string>,
) => BigBedRow[];

/** The reader's generic block walk, which its typings leave out. */
type RawBigWigReader = {
  getHeader(): Promise<{ common: { fullIndexOffset: number } }>;
  readData(
    startChrom: string,
    startBase: number,
    endChrom: string,
    endBase: number,
    treeOffset: number,
    decode: BigBedDecoder,
  ): Promise<BigBedRow[]>;
};

/**
 * The library's bigBed decoder keeps the first nine columns and drops the rest,
 * which for a bigGenePred is where the gene symbol lives. This is the same walk
 * over the same blocks, keeping every column.
 */
const decodeBigBedRows: BigBedDecoder = (data, filterStartChromIndex, filterStartBase, filterEndChromIndex, filterEndBase, chromDict) => {
  const view = new DataView(data);
  const rows: BigBedRow[] = [];
  let offset = 0;
  const minSize = 3 * 4 + 1;
  while (data.byteLength - offset >= minSize) {
    const chromIndex = view.getInt32(offset, true);
    const start = view.getInt32(offset + 4, true);
    const end = view.getInt32(offset + 8, true);
    offset += 12;
    let rest = '';
    while (offset < data.byteLength) {
      const byte = view.getUint8(offset);
      offset += 1;
      if (byte === 0) break;
      rest += String.fromCharCode(byte);
    }
    if (chromIndex < filterStartChromIndex || (chromIndex === filterStartChromIndex && end < filterStartBase)) {
      continue;
    }
    if (chromIndex > filterEndChromIndex || (chromIndex === filterEndChromIndex && start >= filterEndBase)) {
      break;
    }
    const tokens = rest.split('\t');
    const row: BigBedRow = { chr: chromDict[chromIndex] ?? '', start, end };
    if (tokens.length > 0) row.name = tokens[0];
    if (tokens.length > 1) row.score = parseFloat(tokens[1] ?? '');
    if (tokens.length > 2) row.strand = tokens[2];
    if (tokens.length > 3) row.cdStart = parseInt(tokens[3] ?? '', 10);
    if (tokens.length > 4) row.cdEnd = parseInt(tokens[4] ?? '', 10);
    if (tokens.length > 5 && tokens[5] !== '.' && tokens[5] !== '0') {
      const colour = tokens[5] ?? '';
      row.color = colour.includes(',') && !colour.startsWith('rgb') ? `rgb(${colour})` : colour;
    }
    if (tokens.length > 8) {
      const exonCount = parseInt(tokens[6] ?? '', 10);
      const sizes = (tokens[7] ?? '').split(',');
      const starts = (tokens[8] ?? '').split(',');
      const exons: { start: number; end: number }[] = [];
      for (let index = 0; index < exonCount; index += 1) {
        const exonStart = start + parseInt(starts[index] ?? '', 10);
        exons.push({ start: exonStart, end: exonStart + parseInt(sizes[index] ?? '', 10) });
      }
      row.exons = exons;
    }
    if (tokens.length > 9) {
      row.extra = tokens.slice(9);
    }
    rows.push(row);
  }
  return rows;
};

/** bigBed rows in `[start, end)` of `chr`, with every column past BED12 in `extra`. */
export async function readBigBedRows(reader: BigWigReader, chr: string, start: number, end: number): Promise<BigBedRow[]> {
  const raw = reader as unknown as RawBigWigReader;
  const header = await raw.getHeader();
  return raw.readData(chr, start, chr, end, header.common.fullIndexOffset, decodeBigBedRows);
}
