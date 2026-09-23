import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeComputationalPack } from '../data/computationalPack';
import { computationalSeriesKey } from '../lib/computationalOutputSet';

// A mutagenesis row is declared on the output it mutates. The loader fills the
// defaults, and the row must never share a series identity with the plain
// prediction of the same output and channel, or one would be served for the other.

function pack(subtrack: Record<string, unknown>) {
  return normalizeComputationalPack({
    schemaVersion: 1,
    id: 'p',
    name: 'P',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: '/computational/models/p.onnx' },
    subtracks: [
      { id: 'pred', name: 'Pred', kind: 'signal', color: '#77b6ff', height: 76, outputName: 'out', channelIndex: 0 },
      { id: 'ism', name: 'ISM', kind: 'signal', color: '#77b6ff', height: 76, outputName: 'out', channelIndex: 0, ...subtrack },
    ],
  });
}

describe('subtrack mutagenesis', () => {
  it('fills in the defaults', () => {
    const manifest = pack({ mutagenesis: {} });
    expect(manifest.subtracks[1]!.mutagenesis).toEqual({ contextBp: 500, maxSpanBp: 400 });
  });

  it('carries declared values through', () => {
    const manifest = pack({ mutagenesis: { contextBp: 100, maxSpanBp: 250 } });
    expect(manifest.subtracks[1]!.mutagenesis).toEqual({ contextBp: 100, maxSpanBp: 250 });
  });

  it('keeps rows with different contexts apart', () => {
    const wide = pack({ mutagenesis: { contextBp: 500 } });
    const narrow = pack({ mutagenesis: { contextBp: 100 } });
    expect(computationalSeriesKey(wide.subtracks[1]!)).not.toBe(computationalSeriesKey(narrow.subtracks[1]!));
  });

  it('keeps its series identity apart from the prediction it mutates', () => {
    const manifest = pack({ mutagenesis: {} });
    expect(computationalSeriesKey(manifest.subtracks[0]!)).not.toBe(computationalSeriesKey(manifest.subtracks[1]!));
  });
});

describe('one run serves every ISM channel', () => {
  // The three ISM rows of a checkpoint are three channels of one output, and
  // the worker groups mutagenesis outputs by `outputName|contextBp`: one group
  // is one run, one batch of mutants, one forward pass per mutant, with each
  // channel read as a slice of the same output tensor. A pack that declared
  // two different outputs or two different contexts for its ISM rows would
  // quietly triple the model work instead.
  const packDir = 'public/computational/packs';

  it('gives every mutagenesis output in a pack the same output and context', () => {
    for (const file of readdirSync(packDir).filter((name) => name.endsWith('.czpack')).sort()) {
      const pack = normalizeComputationalPack(JSON.parse(readFileSync(`${packDir}/${file}`, 'utf8')));
      const ism = pack.subtracks.filter((subtrack) => subtrack.mutagenesis);
      if (ism.length < 2) continue;

      const groups = new Set(ism.map((subtrack) => `${subtrack.outputName}|${subtrack.mutagenesis!.contextBp}`));
      expect(groups.size, `${file}: ${[...groups].join(' vs ')}`).toBe(1);

      // And they read different channels of it, or two rows would be one row.
      const channels = ism.map((subtrack) => subtrack.channelIndex ?? 0);
      expect(new Set(channels).size, `${file}: channels ${channels.join(',')}`).toBe(ism.length);
    }
  });
});
