import { describe, expect, it } from 'vitest';
import { buildComputationalTrack, replaceComputationalFamilyTracks, type ManagedTrackLike } from '../lib/computationalFamily';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, TrackSpec } from '../types';

// The checkpoint picker swaps one pack for another of the same family. The
// two shipped checkpoints share donor/acceptor outputs and one adds a branchpoint,
// so a swap must keep what the user arranged for the shared outputs, add the new
// ones, and drop the missing ones -- not vanish the family, which is what mapping
// by output id alone did.

function subtrack(id: string, over: Partial<ComputationalSubtrackSpec> = {}): ComputationalSubtrackSpec {
  return { id, name: id, kind: 'signal', color: '#2563EB', height: 76, outputName: 'pred', defaultVisible: true, ...over };
}

function pack(id: string, subtracks: ComputationalSubtrackSpec[]): ComputationalPackManifest {
  return { schemaVersion: 1, id, name: 'Bars model', sequenceProvider: { type: 'ucsc', genome: 'hg38' }, model: { format: 'onnx', url: `/${id}.onnx` }, subtracks };
}

const twoChannel = pack('demo-bars-2ch', [subtrack('demo-bars-2ch-first'), subtrack('demo-bars-2ch-second'), subtrack('demo-bars-2ch-ism-first')]);
const branchpoint = pack('demo-bars-3ch', [
  subtrack('demo-bars-2ch-first'), subtrack('demo-bars-2ch-second'), subtrack('demo-bars-3ch-third', { color: '#059669' }),
  subtrack('demo-bars-2ch-ism-first'), subtrack('demo-bars-3ch-ism-third', { defaultVisible: false }),
]);
const isDemoBars = (packId: string) => packId.startsWith('demo-bars-');

const bigwig: ManagedTrackLike = {
  spec: { id: 'bw', name: 'H3K27ac', kind: 'signal', color: '#0ff', height: 76, source: { type: 'bigwig', url: 'https://x/y.bw' } } satisfies TrackSpec,
  enabled: true,
  order: 0,
};

function mounted(manifest: ComputationalPackManifest, firstOrder: number): ManagedTrackLike[] {
  return manifest.subtracks.map((output, index) => ({
    ...buildComputationalTrack({ pack: manifest, sourceUrl: `/${manifest.id}.czpack`, instanceId: 'catalog_demo-bars', subtrack: output, trackId: `t_${output.id}`, enabled: true }),
    order: firstOrder + index,
  }));
}

const outputIds = (records: ManagedTrackLike[]) =>
  records.map((record) => (record.spec.source.type === 'computational' ? record.spec.source.subtrack.id : record.spec.id));

describe('replaceComputationalFamilyTracks', () => {
  it('keeps shared outputs with the user\'s visibility, adds new ones, and leaves other tracks alone', () => {
    const before = [bigwig, ...mounted(twoChannel, 1)];
    before[2]!.enabled = false; // the user hid the acceptor
    before[3]!.spec.signalDisplay = 'signal'; // and switched the attribution off DNA height

    const after = replaceComputationalFamilyTracks(before, branchpoint, '/bp3.czpack', isDemoBars, (output) => `new_${output.id}`);

    expect(outputIds(after)).toEqual([
      'bw', 'demo-bars-2ch-first', 'demo-bars-2ch-second', 'demo-bars-2ch-ism-first', 'demo-bars-3ch-third', 'demo-bars-3ch-ism-third',
    ]);
    const acceptor = after[2]!;
    expect(acceptor.enabled).toBe(false);
    expect(acceptor.spec.id).toBe('t_demo-bars-2ch-second');
    expect(after[3]!.spec.signalDisplay).toBe('signal');
    expect(after[4]!.enabled).toBe(true);
    expect(after[4]!.spec.id).toBe('new_demo-bars-3ch-third');
    expect(after[4]!.spec.color).toBe('#059669');
    expect(after[5]!.enabled).toBe(false); // the manifest's defaultVisible for a new output
    expect(after[0]).toEqual(bigwig);
    for (const record of after.slice(1)) {
      expect(record.spec.source.type === 'computational' && record.spec.source.pack.id).toBe('demo-bars-3ch');
      expect(record.spec.source.type === 'computational' && record.spec.source.packUrl).toBe('/bp3.czpack');
    }
    expect(after.map((record) => record.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('drops outputs the new checkpoint does not have', () => {
    const after = replaceComputationalFamilyTracks(mounted(branchpoint, 0), twoChannel, '/two.czpack', isDemoBars, (output) => `new_${output.id}`);
    expect(outputIds(after)).toEqual(['demo-bars-2ch-first', 'demo-bars-2ch-second', 'demo-bars-2ch-ism-first']);
  });

  it('does nothing when the family is not mounted', () => {
    const after = replaceComputationalFamilyTracks([bigwig], twoChannel, '/two.czpack', isDemoBars, () => 'unused');
    expect(after).toEqual([bigwig]);
  });
});
