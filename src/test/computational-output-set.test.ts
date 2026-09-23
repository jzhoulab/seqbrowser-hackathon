import { describe, expect, it } from 'vitest';
import {
  computationalOutputSetCovers,
  computationalSeriesKey,
  resolveComputationalOutputSet,
  resolveComputationalOutputSetForSubtracks,
  resolveComputationalWarmupOutputSet,
} from '../lib/computationalOutputSet';
import type { ComputationalPackManifest, ComputationalSubtrackSpec } from '../types';

function subtrack(
  id: string,
  outputName: string,
  groupId?: string,
  defaultVisible?: boolean,
  channelIndex?: number,
): ComputationalSubtrackSpec {
  return {
    id,
    name: id,
    kind: 'signal',
    color: '#77b6ff',
    height: 76,
    outputName,
    channelIndex,
    groupId,
    defaultVisible,
  };
}

function pack(subtracks: ComputationalSubtrackSpec[]): ComputationalPackManifest {
  return {
    schemaVersion: 1,
    id: 'model',
    name: 'Model',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: '/model.onnx' },
    subtracks,
  };
}

describe('computational output sets', () => {
  it('selects and extracts only the requesting grouped collection', () => {
    const model = pack([
      subtrack('prediction-plus', 'prediction', 'overview', true, 0),
      subtrack('prediction-minus', 'prediction', 'overview', true, 1),
      subtrack('motif-1', 'motif_1', 'motifs', false),
    ]);

    const outputSet = resolveComputationalOutputSet(model, model.subtracks[0]);

    expect(outputSet.subtracks.map((item) => item.id)).toEqual([
      'prediction-plus',
      'prediction-minus',
    ]);
    expect(outputSet.outputNames).toEqual(['prediction']);
    expect(outputSet.seriesKeys).toEqual(new Set([
      computationalSeriesKey(model.subtracks[0]),
      computationalSeriesKey(model.subtracks[1]),
    ]));
  });

  it('keeps an ungrouped requesting subtrack pack-wide for legacy packs', () => {
    const model = pack([
      subtrack('legacy', 'prediction'),
      subtrack('optional', 'optional', 'optional-group', false),
    ]);

    const outputSet = resolveComputationalOutputSet(model, model.subtracks[0]);

    expect(outputSet.subtracks.map((item) => item.id)).toEqual(['legacy', 'optional']);
    expect(outputSet.outputNames).toEqual(['prediction', 'optional']);
  });

  it('unions every inference collection represented by a composite plot', () => {
    const model = pack([
      subtrack('primary-a', 'primary_a', 'primary'),
      subtrack('primary-b', 'primary_b', 'primary'),
      subtrack('opposite-a', 'opposite_a', 'opposite'),
      subtrack('unrelated', 'unrelated', 'other'),
    ]);

    const outputSet = resolveComputationalOutputSetForSubtracks(model, [
      model.subtracks[0],
      model.subtracks[2],
    ]);

    expect(outputSet.subtracks.map((item) => item.id)).toEqual([
      'primary-a',
      'primary-b',
      'opposite-a',
    ]);
    expect(outputSet.outputNames).toEqual(['primary_a', 'primary_b', 'opposite_a']);
    expect(outputSet.seriesKeys.has(computationalSeriesKey(model.subtracks[3]))).toBe(false);
  });

  it('uses a stable order-independent identity and only permits safe superset reuse', () => {
    const first = subtrack('first', 'shared', 'group', true, 0);
    const second = subtrack('second', 'shared', 'group', true, 1);
    const ordered = resolveComputationalOutputSet(pack([first, second]), first);
    const reversed = resolveComputationalOutputSet(pack([second, first]), first);
    const subset = resolveComputationalOutputSet(pack([first]), first);

    expect(ordered.key).toBe(reversed.key);
    expect(computationalOutputSetCovers(ordered.seriesKeys, subset.seriesKeys)).toBe(true);
    expect(computationalOutputSetCovers(subset.seriesKeys, ordered.seriesKeys)).toBe(false);
  });

  it('warms whole default-visible groups without loading hidden collections', () => {
    const model = pack([
      subtrack('overview-a', 'overview_a', 'overview', true),
      subtrack('overview-b', 'overview_b', 'overview', false),
      subtrack('motif', 'motif', 'motifs', false),
    ]);

    const outputSet = resolveComputationalWarmupOutputSet(model);

    expect(outputSet.subtracks.map((item) => item.id)).toEqual(['overview-a', 'overview-b']);
    expect(outputSet.outputNames).toEqual(['overview_a', 'overview_b']);
  });

  it('falls back to the first output group when every collection starts hidden', () => {
    const model = pack([
      subtrack('first-a', 'first_a', 'first', false),
      subtrack('first-b', 'first_b', 'first', false),
      subtrack('second', 'second', 'second', false),
    ]);

    const outputSet = resolveComputationalWarmupOutputSet(model);

    expect(outputSet.subtracks.map((item) => item.id)).toEqual(['first-a', 'first-b']);
  });
});
