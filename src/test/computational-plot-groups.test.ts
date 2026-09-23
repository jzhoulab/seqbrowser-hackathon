import { describe, expect, it } from 'vitest';
import { trackSourceKey } from '../data/bbiDataSource';
import {
  coalesceComputationalPlotTracks,
  resolveComputationalSeriesLineStyle,
  resolveComputationalTrackSubtracks,
} from '../lib/computationalPlotGroups';
import type {
  ComputationalPackManifest,
  ComputationalSubtrackSpec,
  TrackSource,
  TrackSpec,
} from '../types';

type ComputationalTrackSpec = TrackSpec & {
  source: Extract<TrackSource, { type: 'computational' }>;
};

function subtrack(
  id: string,
  groupId: string,
  scaleMode: 'positive' | 'signed' = 'positive',
): ComputationalSubtrackSpec {
  return {
    id,
    name: id,
    kind: 'signal',
    color: id.includes('minus') || id.includes('opposite') ? '#93c5fd' : '#2563eb',
    height: 76,
    outputName: id,
    groupId,
    scaleMode,
  };
}

function pack(
  subtracks: ComputationalSubtrackSpec[],
  plotGroups: ComputationalPackManifest['plotGroups'],
): ComputationalPackManifest {
  return {
    schemaVersion: 1,
    id: 'model',
    name: 'Model',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: '/model.onnx' },
    plotGroups,
    subtracks,
  };
}

function computationalTrack(
  model: ComputationalPackManifest,
  id: string,
  instanceId = 'instance-a',
): ComputationalTrackSpec {
  const output = model.subtracks.find((candidate) => candidate.id === id);
  if (!output) {
    throw new Error(`Missing test output ${id}`);
  }
  return {
    id: `${instanceId}-${id}`,
    name: output.name,
    kind: output.kind,
    color: output.color,
    height: output.height,
    source: {
      type: 'computational',
      instanceId,
      packUrl: '/model.czpack',
      pack: model,
      subtrack: output,
    },
  };
}

describe('computational plot groups', () => {
  it('coalesces explicit outputs at their first logical position in manifest order', () => {
    const outputs = [
      subtrack('prediction-plus', 'overview'),
      subtrack('prediction-minus', 'overview', 'signed'),
      subtrack('total-effect', 'overview', 'signed'),
    ];
    const model = pack(outputs, [{
      id: 'prediction',
      label: 'Prediction',
      subtrackIds: ['prediction-plus', 'prediction-minus'],
      dashedSubtrackIds: ['prediction-minus'],
      height: 88,
    }]);
    const ordinary: TrackSpec = {
      id: 'ordinary',
      name: 'Ordinary',
      kind: 'signal',
      color: '#64748b',
      height: 76,
      source: { type: 'mock' },
    };

    const result = coalesceComputationalPlotTracks([
      computationalTrack(model, 'prediction-minus'),
      ordinary,
      computationalTrack(model, 'total-effect'),
      computationalTrack(model, 'prediction-plus'),
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ name: 'Prediction', height: 88 });
    expect(result[1]).toBe(ordinary);
    expect(result[2]?.name).toBe('total-effect');
    expect(result[0]?.source.type).toBe('computational');
    if (result[0]?.source.type !== 'computational') {
      throw new Error('Expected a computational plot source');
    }
    expect(result[0].source.seriesSubtrackIds).toEqual([
      'prediction-plus',
      'prediction-minus',
    ]);
    expect(result[0].source.subtrack.id).toBe('prediction-plus');
    expect(resolveComputationalSeriesLineStyle(result[0].source, outputs[1])).toBe('dashed');
  });

  it('combines whole inference collections and keeps their declared order', () => {
    const outputs = [
      subtrack('primary-1', 'primary', 'signed'),
      subtrack('primary-2', 'primary', 'signed'),
      subtrack('opposite-1', 'opposite', 'signed'),
    ];
    const model = pack(outputs, [{
      id: 'motif-effects',
      label: 'Motif effects',
      groupIds: ['primary', 'opposite'],
      dashedGroupIds: ['opposite'],
    }]);

    const [plot] = coalesceComputationalPlotTracks([
      computationalTrack(model, 'opposite-1'),
      computationalTrack(model, 'primary-2'),
      computationalTrack(model, 'primary-1'),
    ]);

    expect(plot?.source.type).toBe('computational');
    if (plot?.source.type !== 'computational') {
      throw new Error('Expected a computational plot source');
    }
    expect(plot.source.seriesSubtrackIds).toEqual(['primary-1', 'primary-2', 'opposite-1']);
    expect(resolveComputationalSeriesLineStyle(plot.source, outputs[0])).toBe('solid');
    expect(resolveComputationalSeriesLineStyle(plot.source, outputs[2])).toBe('dashed');
  });

  it('never merges separate model instances and permits mixed signal scale annotations', () => {
    const compatibleOutputs = [subtrack('plus', 'overview'), subtrack('minus', 'overview')];
    const compatibleModel = pack(compatibleOutputs, [{
      id: 'prediction',
      label: 'Prediction',
      groupIds: ['overview'],
    }]);
    const separateInstances = coalesceComputationalPlotTracks([
      computationalTrack(compatibleModel, 'plus', 'instance-a'),
      computationalTrack(compatibleModel, 'minus', 'instance-b'),
    ]);
    expect(separateInstances).toHaveLength(2);
    expect(separateInstances[0]?.id).not.toBe(separateInstances[1]?.id);

    const mixedScaleOutputs = [
      subtrack('positive', 'mixed', 'positive'),
      subtrack('signed', 'mixed', 'signed'),
    ];
    const mixedScaleModel = pack(mixedScaleOutputs, [{
      id: 'mixed',
      label: 'Mixed',
      groupIds: ['mixed'],
    }]);
    const mixedScale = coalesceComputationalPlotTracks([
      computationalTrack(mixedScaleModel, 'positive'),
      computationalTrack(mixedScaleModel, 'signed'),
    ]);
    expect(mixedScale).toHaveLength(1);
    expect(mixedScale[0]?.source.type === 'computational' && mixedScale[0].source.seriesSubtrackIds)
      .toEqual(['positive', 'signed']);
  });

  it('uses ordered series ids in the post-inference track cache identity', () => {
    const outputs = [subtrack('a', 'group'), subtrack('b', 'group')];
    const model = pack(outputs, undefined);
    const single = computationalTrack(model, 'a');
    const forward: TrackSpec = {
      ...single,
      source: { ...single.source, seriesSubtrackIds: ['a', 'b'] },
    };
    const reverse = computationalTrack(model, 'b');
    const reverseComposite: TrackSpec = {
      ...reverse,
      source: { ...reverse.source, seriesSubtrackIds: ['b', 'a'] },
    };

    expect(trackSourceKey(single)).not.toBe(trackSourceKey(forward));
    expect(trackSourceKey(forward)).not.toBe(trackSourceKey(reverseComposite));
    expect(trackSourceKey(forward)).toContain(encodeURIComponent(JSON.stringify(['a', 'b'])));
  });

  it('rejects an invalid or primary-less ordered series declaration', () => {
    const outputs = [subtrack('a', 'group'), subtrack('b', 'group')];
    const model = pack(outputs, undefined);
    const track = computationalTrack(model, 'a');
    if (track.source.type !== 'computational') {
      throw new Error('Expected a computational source');
    }

    expect(() => resolveComputationalTrackSubtracks({
      ...track.source,
      seriesSubtrackIds: ['missing', 'a'],
    })).toThrow(/does not define subtrack "missing"/);
    expect(() => resolveComputationalTrackSubtracks({
      ...track.source,
      seriesSubtrackIds: ['b'],
    })).toThrow(/must include its primary subtrack "a"/);
  });
});
