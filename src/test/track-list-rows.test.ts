import { describe, expect, it } from 'vitest';
import { buildTrackListRows, trackRangeForRows } from '../features/tracks/listRows';
import { SEQUENCE_SECTION_COLORS, assignModelGroupColors, modelGroupColor, subgroupColor } from '../lib/groupColors';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, TrackSpec } from '../types';

// The track list shows a mounted model as a group and its output collections
// as subgroups, from headers derived from the rows. The colours that mark them
// are assigned per model in mount order and shaded per collection.

function subtrack(id: string, groupId: string, groupLabel: string): ComputationalSubtrackSpec {
  return { id, name: id, kind: 'signal', color: '#2563eb', height: 60, outputName: 'pred', groupId, groupLabel };
}

const SPLICE: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'splice',
  name: 'Bars model',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/m.onnx' },
  subtracks: [
    subtrack('donor', 'overview', 'Prediction'),
    subtrack('acceptor', 'overview', 'Prediction'),
    subtrack('attrib-donor', 'attribution', 'Attribution'),
    subtrack('attrib-acceptor', 'attribution', 'Attribution'),
  ],
};

const SINGLE: ComputationalPackManifest = {
  ...SPLICE,
  id: 'single',
  name: 'Single',
  subtracks: [subtrack('a', 'overview', 'Overview'), subtrack('b', 'overview', 'Overview')],
};

function modelTrack(pack: ComputationalPackManifest, subtrackId: string, instanceId = `${pack.id}-1`): TrackSpec {
  const sub = pack.subtracks.find((s) => s.id === subtrackId)!;
  return {
    id: `${instanceId}:${subtrackId}`,
    name: sub.name,
    color: sub.color,
    height: 60,
    kind: 'signal',
    source: { type: 'computational', instanceId, packUrl: '/p.czpack', pack, subtrack: sub },
  };
}

const GENES: TrackSpec = { id: 'genes', name: 'Genes', color: '#000', height: 60, kind: 'annotation', source: { type: 'mock' } };

describe('buildTrackListRows', () => {
  it('puts a model header above a model and a subgroup header above each of its collections', () => {
    const tracks = [modelTrack(SPLICE, 'donor'), modelTrack(SPLICE, 'attrib-donor'), modelTrack(SPLICE, 'attrib-acceptor'), GENES];
    const rows = buildTrackListRows(tracks, assignModelGroupColors(['splice-1']));
    expect(rows.map((row) => row.kind)).toEqual([
      'model-header', 'subgroup-header', 'track', 'subgroup-header', 'track', 'track', 'track',
    ]);
    const attribution = rows[3];
    expect(attribution.kind === 'subgroup-header' && attribution.label).toBe('Attribution');
    expect(attribution.kind === 'subgroup-header' && attribution.count).toBe(2);
    const row = rows[4];
    expect(row.kind === 'track' && row.grouping).toMatchObject({ instanceId: 'splice-1', subgroupId: 'attribution', depth: 2 });
    const genes = rows[6];
    expect(genes.kind === 'track' && genes.grouping).toBeUndefined();
  });

  it('gives a model with one collection no subgroup header, and its rows depth 1', () => {
    const rows = buildTrackListRows([modelTrack(SINGLE, 'a'), modelTrack(SINGLE, 'b')], assignModelGroupColors(['single-1']));
    expect(rows.map((row) => row.kind)).toEqual(['model-header', 'track', 'track']);
    expect(rows[1].kind === 'track' && rows[1].grouping?.depth).toBe(1);
  });

  it('starts a new header where another model, or a data track, interrupts', () => {
    const tracks = [modelTrack(SPLICE, 'donor'), GENES, modelTrack(SPLICE, 'attrib-donor')];
    const rows = buildTrackListRows(tracks, assignModelGroupColors(['splice-1']));
    expect(rows.filter((row) => row.kind === 'model-header')).toHaveLength(2);
  });

  it('colours each model in mount order and each collection as a shade of its model', () => {
    const colors = assignModelGroupColors(['b', 'a', 'b']);
    expect(colors.get('b')).toBe(modelGroupColor(0));
    expect(colors.get('a')).toBe(modelGroupColor(1));
    const rows = buildTrackListRows([modelTrack(SPLICE, 'donor'), modelTrack(SPLICE, 'attrib-donor')], colors);
    const [prediction, attribution] = rows.filter((row) => row.kind === 'subgroup-header');
    expect(prediction!.kind === 'subgroup-header' && prediction!.subgroupColor).toBe(subgroupColor('#7c3aed', 0, 2));
    expect(attribution!.kind === 'subgroup-header' && attribution!.subgroupColor).toBe(subgroupColor('#7c3aed', 1, 2));
    expect(prediction!.kind === 'subgroup-header' && prediction!.subgroupColor).not.toBe(
      attribution!.kind === 'subgroup-header' && attribution!.subgroupColor,
    );
  });

  it('marks an edited layout by section: the edited rows in the edit colour, the rest under the reference strip', () => {
    const edited: TrackSpec = {
      ...modelTrack(SPLICE, 'donor'),
      id: 'edited',
      source: { type: 'computational', instanceId: 'splice-1', packUrl: '/p.czpack', pack: SPLICE, subtrack: SPLICE.subtracks[0]!, editRole: 'edited' },
    };
    const reference: TrackSpec = { id: 'sequence-reference', name: 'Reference sequence', color: '#64748b', height: 18, kind: 'annotation', source: { type: 'sequence-variant', variantId: '__reference__', edits: [] } };
    const rows = buildTrackListRows([edited, reference, modelTrack(SPLICE, 'donor'), GENES], assignModelGroupColors(['splice-1']), ['splice-1']);
    // No header rows: the two sequence rows are the markers.
    expect(rows.map((row) => row.kind)).toEqual(['track', 'track', 'model-header', 'subgroup-header', 'track', 'track']);
    expect(rows[0].kind === 'track' && rows[0].grouping).toMatchObject({ section: 'edited', groupColor: SEQUENCE_SECTION_COLORS.edited, depth: 1 });
    expect(rows[1]).toMatchObject({ kind: 'track', id: 'sequence-reference' });
    // Rows under the reference keep their model grouping and know their section.
    expect(rows[4].kind === 'track' && rows[4].grouping).toMatchObject({ section: 'reference', depth: 2 });
    expect(rows[5].kind === 'track' && rows[5].grouping).toBeUndefined();
  });

  it('has no sections while the sequence is unedited', () => {
    const rows = buildTrackListRows([modelTrack(SPLICE, 'donor'), GENES], assignModelGroupColors(['splice-1']));
    expect(rows.every((row) => row.kind !== 'track' || row.grouping?.section === undefined)).toBe(true);
  });

  it('gives a model with every output hidden a header at the top', () => {
    const rows = buildTrackListRows([GENES], new Map([['splice-1', '#7c3aed']]), ['splice-1']);
    expect(rows.map((row) => row.kind)).toEqual(['model-header', 'track']);
  });
});

describe('trackRangeForRows', () => {
  it('maps visible rows to the tracks among them, skipping headers', () => {
    const tracks = [modelTrack(SPLICE, 'donor'), modelTrack(SPLICE, 'attrib-donor'), GENES];
    const rows = buildTrackListRows(tracks, assignModelGroupColors(['splice-1']));
    // Rows: header, sub, donor(0), sub, attrib(1), genes(2).
    expect(trackRangeForRows(rows, { startIndex: 0, endIndex: 2 })).toEqual({ startIndex: 0, endIndex: 0 });
    expect(trackRangeForRows(rows, { startIndex: 3, endIndex: 5 })).toEqual({ startIndex: 1, endIndex: 2 });
    // Only headers in view: the next track after them.
    expect(trackRangeForRows(rows, { startIndex: 0, endIndex: 1 })).toEqual({ startIndex: 0, endIndex: 0 });
  });
});

describe('subgroupColor', () => {
  it('returns the parent for a lone subgroup and distinct shades otherwise', () => {
    expect(subgroupColor('#7c3aed', 0, 1)).toBe('#7c3aed');
    const shades = [0, 1, 2].map((index) => subgroupColor('#7c3aed', index, 3));
    expect(new Set(shades).size).toBe(3);
    for (const shade of shades) {
      expect(shade).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
