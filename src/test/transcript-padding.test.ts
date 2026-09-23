import { describe, expect, it } from 'vitest';
import { applyTranscriptPadding, transcriptPaddingIntervals } from '../lib/transcriptPadding';

// A transcript model's training windows had 500 N beyond each end of a canonical transcript,
// read on the transcript's strand. The browser reproduces that per displayed
// strand, and only where no other same-strand transcript covers the bases.

const actb = { start: 5_527_147, end: 5_530_601, strand: '-' as const };   // MANE Select, hg38

describe('transcriptPaddingIntervals', () => {
  it('pads both ends of a same-strand transcript, clipped to the window', () => {
    const intervals = transcriptPaddingIntervals([actb], '-', 5_526_200, 5_531_200, 500);
    expect(intervals).toEqual([
      { start: 5_526_647, end: 5_527_147 },
      { start: 5_530_601, end: 5_531_101 },
    ]);
    expect(transcriptPaddingIntervals([actb], '-', 5_530_900, 5_532_000, 500)).toEqual([{ start: 5_530_900, end: 5_531_101 }]);
  });

  it('pads nothing for the other strand, or when the transcript is far from the window', () => {
    expect(transcriptPaddingIntervals([actb], '+', 5_526_200, 5_531_200, 500)).toEqual([]);
    expect(transcriptPaddingIntervals([actb], '-', 5_528_000, 5_529_000, 500)).toEqual([]);
  });

  it('leaves bases inside another same-strand transcript alone', () => {
    const upstream = { start: 5_530_800, end: 5_540_000, strand: '-' as const };   // starts 199 bp past ACTB's end
    expect(transcriptPaddingIntervals([actb, upstream], '-', 5_526_200, 5_531_200, 500)).toEqual([
      { start: 5_526_647, end: 5_527_147 },
      { start: 5_530_601, end: 5_530_800 },
    ]);
  });
});

describe('applyTranscriptPadding', () => {
  it('writes N over the intervals in window coordinates and nothing else', () => {
    const sequence = 'ACGTACGTAC';
    expect(applyTranscriptPadding(sequence, 100, [{ start: 102, end: 104 }, { start: 108, end: 120 }])).toBe('ACNNACGTNN');
    expect(applyTranscriptPadding(sequence, 100, [])).toBe(sequence);
  });
});
