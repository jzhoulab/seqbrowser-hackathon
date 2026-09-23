import { describe, expect, it } from 'vitest';

import { buildTrackManagerView } from '../features/tracks/managerView';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, TrackSpec } from '../types';

function output(id: string, groupId: string): ComputationalSubtrackSpec {
  return { id, name: id, outputName: id, groupId, kind: 'signal', color: '#7c3aed', height: 76 };
}

const outputs = [output('plus', 'overview'), output('minus', 'overview'), output('yy1', 'attribution')];
const pack: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'puffin-test',
  name: 'Puffin test',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/model.onnx' },
  plotGroups: [{ id: 'prediction', label: 'Prediction', subtrackIds: ['plus', 'minus'] }],
  subtracks: outputs,
};

function modelTrack(subtrack: ComputationalSubtrackSpec): TrackSpec {
  return {
    id: `track-${subtrack.id}`,
    name: subtrack.name,
    color: subtrack.color,
    height: subtrack.height,
    kind: subtrack.kind,
    source: {
      type: 'computational',
      instanceId: 'puffin-a',
      packUrl: '/puffin.czpack',
      pack,
      subtrack,
    },
  };
}

describe('buildTrackManagerView', () => {
  it('represents a multi-series computational plot as one manager row', () => {
    const view = buildTrackManagerView([
      { spec: modelTrack(outputs[0]), enabled: true, order: 0 },
      { spec: modelTrack(outputs[1]), enabled: false, order: 1 },
      { spec: modelTrack(outputs[2]), enabled: true, order: 2 },
    ]);

    expect(view).toHaveLength(2);
    expect(view[0]).toMatchObject({
      name: 'Prediction',
      memberIds: ['track-plus', 'track-minus'],
      enabledCount: 1,
      totalCount: 2,
      visibility: 'partial',
      renameable: false,
      collectionName: 'Puffin test',
    });
    expect(view[1]).toMatchObject({ name: 'yy1', memberIds: ['track-yy1'], visibility: 'shown' });
  });

  it('keeps ordinary tracks individual under the Data collection', () => {
    const data: TrackSpec = {
      id: 'data-a', name: 'Data A', kind: 'signal', color: '#0e7490', height: 76,
      source: { type: 'bigwig', url: '/data/a.bw' },
    };
    expect(buildTrackManagerView([{ spec: data, enabled: true, order: 0 }])[0]).toMatchObject({
      id: 'data-a',
      memberIds: ['data-a'],
      origin: 'data',
      collectionName: 'Data tracks',
      sourceLabel: 'BigWig signal',
    });
  });
});
