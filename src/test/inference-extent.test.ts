import { describe, expect, it } from 'vitest';
import { deriveCoveredExtent } from '../lib/inferenceExtent';

// The bundled packs declare flanks that match their models exactly. Measured by
// running each ONNX model at two input lengths:
//   seqbro2-puffin (flank 325): L=1024 -> 374,  L=2048 -> 1398   (out = L - 650)
//   seqbro2-motif  (flank 14):  L=1024 -> 996,  L=2048 -> 2020   (out = L - 28)
//   vibe-motifmatch (flank 0):  L=1024 -> 10,   L=2048 -> 20     (downsampling)

describe('deriveCoveredExtent', () => {
  it('returns the requested window when both flanks were available', () => {
    // Puffin: request 1000..1698 fetched with full 325bp flanks on each side.
    const extent = deriveCoveredExtent({
      sequenceStart: 675,
      sequenceLength: 1348,
      flankBp: 325,
      requestStart: 1000,
      requestEnd: 1698,
    });

    expect(extent.coveredStart).toBe(1000);
    expect(extent.coveredEnd).toBe(1698);
  });

  it('returns the requested window for a zero-flank pack', () => {
    const extent = deriveCoveredExtent({
      sequenceStart: 2000,
      sequenceLength: 1024,
      flankBp: 0,
      requestStart: 2000,
      requestEnd: 3024,
    });

    expect(extent.coveredStart).toBe(2000);
    expect(extent.coveredEnd).toBe(3024);
  });

  it('reports a truncated left edge when the flank is clipped at the chromosome start', () => {
    // Request 100..798 wants a 325bp left flank but only 100bp exists before it,
    // so the model cannot emit output for the first 225bp of the request.
    const extent = deriveCoveredExtent({
      sequenceStart: 0,
      sequenceLength: 1123,
      flankBp: 325,
      requestStart: 100,
      requestEnd: 798,
    });

    expect(extent.coveredStart).toBe(325);
    expect(extent.coveredEnd).toBe(798);
  });

  it('reports a truncated right edge when the provider returns a short sequence', () => {
    // Chromosome ends mid-window: 1348bp asked for, 900bp returned.
    const extent = deriveCoveredExtent({
      sequenceStart: 675,
      sequenceLength: 900,
      flankBp: 325,
      requestStart: 1000,
      requestEnd: 1698,
    });

    expect(extent.coveredStart).toBe(1000);
    expect(extent.coveredEnd).toBe(1250);
  });

  it('falls back to the requested window when the sequence is shorter than its flanks', () => {
    const extent = deriveCoveredExtent({
      sequenceStart: 675,
      sequenceLength: 400,
      flankBp: 325,
      requestStart: 1000,
      requestEnd: 1698,
    });

    expect(extent.coveredStart).toBe(1000);
    expect(extent.coveredEnd).toBe(1698);
  });
});
