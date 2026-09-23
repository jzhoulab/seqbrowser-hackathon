import { describe, expect, it } from 'vitest';
import { trackSourceKey } from '../data/bbiDataSource';
import { orientSequenceForModel, orientTracksForStrand, restoreGenomicOrder } from '../lib/modelStrand';
import type { ComputationalPackManifest, TrackSpec } from '../types';

// Reading the minus strand reverse-complements the whole browser, so a model that
// scores one orientation has to see the reverse complement too. The flag rides
// the computational source: it reaches the worker with the request and changes
// every cache key on the way, so a strand flip can never show plus-strand scores
// merely mirrored.

const pack: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'demo-bars-2ch',
  name: 'Bars model',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/m.onnx' },
  subtracks: [{ id: 'demo-bars-2ch-first', name: 'Donor', kind: 'signal', color: '#2563EB', height: 76, outputName: 'pred' }],
};
const plot: TrackSpec = {
  id: 'p', name: 'Donor', kind: 'signal', color: '#2563EB', height: 96,
  source: { type: 'computational', instanceId: 'i1', packUrl: '/p.czpack', pack, subtrack: pack.subtracks[0]! },
};
const bigwig: TrackSpec = { id: 'bw', name: 'H3K27ac', kind: 'signal', color: '#0ff', height: 76, source: { type: 'bigwig', url: 'https://x/y.bw' } };

describe('orientTracksForStrand', () => {
  it('on the plus strand leaves every track as it is', () => {
    expect(orientTracksForStrand([plot, bigwig], false)).toEqual([plot, bigwig]);
  });

  it('on the minus strand flags computational sources, and only those', () => {
    const [model, data] = orientTracksForStrand([plot, bigwig], true);
    expect(model!.source.type === 'computational' && model!.source.reverseComplement).toBe(true);
    expect(data).toBe(bigwig);
  });

  it('changes the cache key, so a flip cannot be served plus-strand scores', () => {
    const [minus] = orientTracksForStrand([plot], true);
    expect(trackSourceKey(minus!)).not.toBe(trackSourceKey(plot));
  });
});

describe('model input and output orientation', () => {
  it('feeds the reverse complement on the minus strand', () => {
    expect(orientSequenceForModel('AACGT', false)).toBe('AACGT');
    expect(orientSequenceForModel('AACGT', true)).toBe('ACGTT');
  });

  it('maps outputs back to genomic order without touching the original', () => {
    const values = new Float32Array([1, 2, 3, 4]);
    expect(restoreGenomicOrder(values, false)).toBe(values);
    expect(Array.from(restoreGenomicOrder(values, true))).toEqual([4, 3, 2, 1]);
    expect(Array.from(values)).toEqual([1, 2, 3, 4]);
  });

  it('with an equal flank on both sides, an un-flipped output lines up with the genomic base it came from', () => {
    const sequence = 'ACGTTGCAAC';
    const flank = 1;
    const scoreG = (s: string) => Float32Array.from(s.slice(flank, -flank), (base) => (base === 'G' ? 1 : 0));
    const minus = restoreGenomicOrder(scoreG(orientSequenceForModel(sequence, true)), true);
    // On the minus strand a G is read wherever the plus strand has a C.
    expect(Array.from(minus)).toEqual(Array.from(sequence.slice(flank, -flank), (base) => (base === 'C' ? 1 : 0)));
  });
});
