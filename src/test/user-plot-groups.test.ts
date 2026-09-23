import { describe, expect, it } from 'vitest';
import { trackSourceKey } from '../data/bbiDataSource';
import { coalesceComputationalPlotTracks } from '../lib/computationalPlotGroups';
import type { ManagedTrackLike } from '../lib/computationalFamily';
import { signalRenderStyle } from '../lib/signalRenderStyle';
import { trackUsesSignedSignalScale } from '../lib/trackSignalScale';
import { deriveTrackWindowSpec } from '../lib/trackWindowSpec';
import {
  applyPlotGroupingAction,
  coalesceUserPlotTracks,
  groupTracks,
  plotGroupingAction,
  renameUserGroup,
  ungroupTracks,
} from '../lib/userPlotGroups';
import { buildTrackManagerView } from '../features/tracks/managerView';
import type { ComputationalPackManifest, DataWindowSpec, TrackSpec, ViewportState } from '../types';

// A combined plot is synthesized on every render from the enabled members, so
// what the user decides -- split a pack's plot, recombine it, group any signal
// tracks into one row -- lives on the member records and is read back by the
// coalescers. These pin that round trip and the pieces a group row relies on.

const pack: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'demo-bars-2ch',
  name: 'Bars model',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/m.onnx' },
  inference: { flankBp: 500, maxWindowBp: 6000 },
  plotGroups: [{ id: 'demo-bars-pred', label: 'Per-base prediction', subtrackIds: ['demo-bars-2ch-first', 'demo-bars-2ch-second'] }],
  subtracks: [
    { id: 'demo-bars-2ch-first', name: 'Donor', kind: 'signal', color: '#2563EB', height: 76, outputName: 'pred', channelIndex: 0, scaleMode: 'positive', renderStyle: 'bars' },
    { id: 'demo-bars-2ch-second', name: 'Acceptor', kind: 'signal', color: '#EA580C', height: 76, outputName: 'pred', channelIndex: 1, scaleMode: 'positive', renderStyle: 'bars' },
    { id: 'demo-bars-2ch-ism-first', name: 'Donor attribution', kind: 'signal', color: '#2563EB', height: 76, outputName: 'attrib', channelIndex: 0, scaleMode: 'signed' },
  ],
};

function output(id: string, over: Partial<TrackSpec> = {}): TrackSpec {
  const subtrack = pack.subtracks.find((candidate) => candidate.id === id)!;
  return {
    id: `t_${id}`, name: subtrack.name, kind: 'signal', color: subtrack.color, height: 76,
    source: { type: 'computational', instanceId: 'catalog_demo-bars', packUrl: '/p.czpack', pack, subtrack },
    ...over,
  };
}
const bigwig: TrackSpec = { id: 'bw', name: 'H3K27ac', kind: 'signal', color: '#0ff', height: 76, source: { type: 'bigwig', url: 'https://x/y.bw' } };
const gencode: TrackSpec = { id: 'gc', name: 'GENCODE', kind: 'annotation', color: '#f00', height: 96, source: { type: 'bigbed', url: 'https://x/g.bb' } };

const records = (...specs: TrackSpec[]): ManagedTrackLike[] => specs.map((spec, order) => ({ spec, enabled: true, order }));
const ids = (tracks: readonly TrackSpec[]) => tracks.map((track) => track.id);
const memberIds = (track: TrackSpec) => (track.source.type === 'group' ? track.source.members.map((member) => member.id) : []);

describe('splitting and recombining a pack plot', () => {
  it('a split member is left out of its pack plot and draws alone', () => {
    const donor = output('demo-bars-2ch-first', { plotGrouping: 'split' });
    const acceptor = output('demo-bars-2ch-second', { plotGrouping: 'split' });
    expect(ids(coalesceComputationalPlotTracks([donor, acceptor]))).toEqual(['t_demo-bars-2ch-first', 't_demo-bars-2ch-second']);
  });

  it('the row buttons: SPLIT on a combined plot, COMBINE on a split member, nothing on an ordinary output', () => {
    const [plot] = coalesceComputationalPlotTracks([output('demo-bars-2ch-first'), output('demo-bars-2ch-second')]);
    expect(plotGroupingAction(plot!)?.kind).toBe('split');
    expect(plotGroupingAction(output('demo-bars-2ch-first', { plotGrouping: 'split' }))?.kind).toBe('combine');
    expect(plotGroupingAction(output('demo-bars-2ch-ism-first'))).toBeNull();
    expect(plotGroupingAction(bigwig)).toBeNull();
  });

  it('SPLIT marks every member of the rendered plot; COMBINE clears the whole plot group', () => {
    const before = records(output('demo-bars-2ch-first'), output('demo-bars-2ch-second'), output('demo-bars-2ch-ism-first'), bigwig);
    const [plot] = coalesceComputationalPlotTracks(before.map((record) => record.spec));
    const split = applyPlotGroupingAction(before, plot!, 'split');
    expect(split.map((record) => record.spec.plotGrouping)).toEqual(['split', 'split', undefined, undefined]);

    const combined = applyPlotGroupingAction(split, split[1]!.spec, 'combine');
    expect(combined.map((record) => record.spec.plotGrouping)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('user-defined combined plots', () => {
  it('grouping needs two signal tracks and puts them in one row at the first member\'s position', () => {
    const before = records(gencode, bigwig, output('demo-bars-2ch-ism-first'));
    expect(groupTracks(before, ['bw'], 'g1')).toEqual(before);
    expect(groupTracks(before, ['gc', 'bw'], 'g1')).toEqual(before); // an annotation cannot join

    const grouped = groupTracks(before, ['bw', 't_demo-bars-2ch-ism-first'], 'g1');
    const rows = coalesceUserPlotTracks(grouped.map((record) => record.spec));
    expect(ids(rows)).toEqual(['gc', 'user-plot:g1']);
    const row = rows[1]!;
    expect(row.name).toBe('H3K27ac + Donor attribution');
    expect(row.kind).toBe('signal');
    expect(memberIds(row)).toEqual(['bw', 't_demo-bars-2ch-ism-first']);
    expect(row.source.type === 'group' && row.source.members[0]!.source.type).toBe('bigwig');
  });

  it('a user group claims a pack output out of its pack plot, which narrows to what is left', () => {
    const grouped = groupTracks(records(output('demo-bars-2ch-first'), output('demo-bars-2ch-second'), bigwig), ['t_demo-bars-2ch-first', 'bw'], 'g1');
    const rows = coalesceUserPlotTracks(coalesceComputationalPlotTracks(grouped.map((record) => record.spec)));
    expect(ids(rows)).toEqual(['user-plot:g1', 'computational-plot:catalog_demo-bars:demo-bars-pred']);
    expect(rows[1]!.source.type === 'computational' && rows[1]!.source.seriesSubtrackIds).toEqual(['demo-bars-2ch-second']);
  });

  it('a group with one enabled member draws that member as itself', () => {
    const grouped = groupTracks(records(bigwig, output('demo-bars-2ch-ism-first')), ['bw', 't_demo-bars-2ch-ism-first'], 'g1');
    expect(ids(coalesceUserPlotTracks([grouped[0]!.spec]))).toEqual(['bw']);
  });

  it('UNGROUP on the row, or Ungroup in the manager, dissolves it', () => {
    const grouped = groupTracks(records(bigwig, output('demo-bars-2ch-ism-first')), ['bw', 't_demo-bars-2ch-ism-first'], 'g1');
    const [row] = coalesceUserPlotTracks(grouped.map((record) => record.spec));
    expect(plotGroupingAction(row!)?.kind).toBe('ungroup');
    expect(applyPlotGroupingAction(grouped, row!, 'ungroup').map((record) => record.spec.userGroup)).toEqual([undefined, undefined]);
    expect(ungroupTracks(grouped, ['bw', 't_demo-bars-2ch-ism-first']).map((record) => record.spec.userGroup)).toEqual([undefined, undefined]);
  });

  it('renaming a member names the group, and the manager shows one renameable row', () => {
    const grouped = groupTracks(records(bigwig, output('demo-bars-2ch-ism-first'), gencode), ['bw', 't_demo-bars-2ch-ism-first'], 'g1');
    const named = renameUserGroup(grouped, 'bw', 'Marks vs model')!;
    expect(named.map((record) => record.spec.userGroup?.label)).toEqual(['Marks vs model', 'Marks vs model', undefined]);
    expect(renameUserGroup(grouped, 'gc', 'x')).toBeNull();

    const view = buildTrackManagerView(named);
    expect(view.map((item) => [item.id, item.name, item.memberIds, item.plotKind])).toEqual([
      ['user-group:g1', 'Marks vs model', ['bw', 't_demo-bars-2ch-ism-first'], 'user'],
      ['gc', 'GENCODE', ['gc'], undefined],
    ]);
    expect(buildTrackManagerView(grouped)[0]!.name).toBe('H3K27ac + Donor attribution');
  });
});

describe('what a group row inherits from its members', () => {
  const grouped = groupTracks(records(bigwig, output('demo-bars-2ch-first'), output('demo-bars-2ch-ism-first')), ['bw', 't_demo-bars-2ch-first', 't_demo-bars-2ch-ism-first'], 'g1');
  const [row] = coalesceUserPlotTracks(grouped.map((record) => record.spec));

  it('draws bars if any member does, and a signed axis if any member is signed', () => {
    expect(signalRenderStyle(row!)).toBe('bars');
    expect(trackUsesSignedSignalScale(row!)).toBe(true);
    const [plain] = coalesceUserPlotTracks(groupTracks(records(bigwig, output('demo-bars-2ch-ism-first')), ['bw', 't_demo-bars-2ch-ism-first'], 'g2').map((r) => r.spec));
    expect(signalRenderStyle(plain!)).toBe('line');
  });

  it('asks for the window its model member needs, and the base window without one', () => {
    const viewport: ViewportState = { chr: 'chr7', chrLength: 159_345_973, centerBp: 5_528_200, bpPerPx: 2, widthPx: 1000, range: { start: 5_527_200, end: 5_529_200, span: 2000 } } as ViewportState;
    const base: DataWindowSpec = { key: 'base', requestStart: 5_520_000, requestEnd: 5_540_000, resolutionBp: 2 };
    expect(deriveTrackWindowSpec(row!, viewport, base)).toEqual(deriveTrackWindowSpec(output('demo-bars-2ch-first'), viewport, base));
    const [dataOnly] = coalesceUserPlotTracks(groupTracks(records(bigwig, { ...bigwig, id: 'bw2' }), ['bw', 'bw2'], 'g3').map((r) => r.spec));
    expect(deriveTrackWindowSpec(dataOnly!, viewport, base)).toBe(base);
  });

  it('is cached by its membership', () => {
    const [other] = coalesceUserPlotTracks(groupTracks(records(bigwig, output('demo-bars-2ch-first')), ['bw', 't_demo-bars-2ch-first'], 'g4').map((r) => r.spec));
    expect(trackSourceKey(row!)).not.toBe(trackSourceKey(other!));
    expect(trackSourceKey(row!)).toContain(trackSourceKey(bigwig));
  });
});
