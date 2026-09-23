import { describe, expect, it } from 'vitest';
import { buildComputationalTrack, replaceComputationalFamilyTracks } from '../lib/computationalFamily';
import type { ComputationalPackManifest, ComputationalSubtrackSpec } from '../types';

// Swapping a checkpoint: an output the new pack adds joins the collection it
// belongs to as the user left it. With the ISM rows shown, the branchpoint
// checkpoint's third ISM row arrives shown too; with them hidden, hidden.

function subtrack(id: string, groupId: string, defaultVisible: boolean): ComputationalSubtrackSpec {
  return { id, name: id, kind: 'signal', color: '#2563eb', height: 60, outputName: 'pred', groupId, defaultVisible };
}

function pack(id: string, subtracks: ComputationalSubtrackSpec[]): ComputationalPackManifest {
  return { schemaVersion: 1, id, name: 'Bars model', sequenceProvider: { type: 'ucsc', genome: 'hg38' }, model: { format: 'onnx', url: `/${id}.onnx` }, subtracks };
}

const TWO = pack('fam-a', [subtrack('donor', 'overview', true), subtrack('ism-donor', 'attribution', false)]);
const THREE = pack('fam-b', [subtrack('donor', 'overview', true), subtrack('ism-donor', 'attribution', false), subtrack('ism-branch', 'attribution', false)]);
const isFamily = (packId: string) => packId.startsWith('fam-');

function mounted(shownIsm: boolean) {
  return TWO.subtracks.map((sub, order) => ({
    ...buildComputationalTrack({ pack: TWO, sourceUrl: '/a.czpack', instanceId: 'fam', subtrack: sub, trackId: `t:${sub.id}`, enabled: sub.groupId === 'attribution' ? shownIsm : true }),
    order,
  }));
}

describe('replaceComputationalFamilyTracks', () => {
  it('shows a new output when its collection was shown before the swap', () => {
    const next = replaceComputationalFamilyTracks(mounted(true), THREE, '/b.czpack', isFamily, (sub) => `t:${sub.id}`);
    const branch = next.find((record) => record.spec.source.type === 'computational' && record.spec.source.subtrack.id === 'ism-branch');
    expect(branch?.enabled).toBe(true);
  });

  it('keeps a new output hidden when its collection was hidden, as the manifest defaults', () => {
    const next = replaceComputationalFamilyTracks(mounted(false), THREE, '/b.czpack', isFamily, (sub) => `t:${sub.id}`);
    const branch = next.find((record) => record.spec.source.type === 'computational' && record.spec.source.subtrack.id === 'ism-branch');
    expect(branch?.enabled).toBe(false);
  });
});
