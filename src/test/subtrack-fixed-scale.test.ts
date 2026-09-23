import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeComputationalPack } from '../data/computationalPack';

// A signed output (a per-base contribution) is centred on zero and unbounded in both
// directions. Pinning its axis clips whichever half falls outside the range.
//
// This regressed once already: the app forced `yScale: {mode:'fixed',min:0,max:1}` on
// every subtrack of any pack whose id started with a model's prefix, so that pack's
// signed attribution outputs rendered with their negative half cut off. The pin now
// comes from the manifest per output, and both halves of that invariant are pinned
// here: a signed output must never carry one, and the loader must refuse if it does.

function subtrack(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'p',
    name: 'P',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: '/computational/models/p.onnx' },
    subtracks: [
      { id: 'a', name: 'A', kind: 'signal', color: '#77b6ff', height: 76, outputName: 'out', ...overrides },
    ],
  };
}

describe('subtrack fixedScale', () => {
  it('carries a declared range through the loader', () => {
    const pack = normalizeComputationalPack(subtrack({ scaleMode: 'positive', fixedScale: { min: 0, max: 1 } }));
    expect(pack.subtracks[0].fixedScale).toEqual({ min: 0, max: 1 });
  });

  it('leaves outputs without a declared range unpinned, so they auto-scale', () => {
    const pack = normalizeComputationalPack(subtrack({ scaleMode: 'signed' }));
    expect(pack.subtracks[0].fixedScale).toBeUndefined();
  });

  it('refuses to pin a signed output, which would clip its negative half', () => {
    expect(() =>
      normalizeComputationalPack(subtrack({ scaleMode: 'signed', fixedScale: { min: 0, max: 1 } })),
    ).toThrow(/signed/i);
  });

  it('refuses an inverted range', () => {
    expect(() =>
      normalizeComputationalPack(subtrack({ fixedScale: { min: 1, max: 0 } })),
    ).toThrow(/greater than/i);
  });

  it('no shipped pack pins a signed output', () => {
    const dir = 'public/computational/packs';
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.czpack'))) {
      const pack = normalizeComputationalPack(JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')));
      for (const sub of pack.subtracks) {
        if (sub.scaleMode === 'signed' && sub.fixedScale) offenders.push(`${file}:${sub.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
