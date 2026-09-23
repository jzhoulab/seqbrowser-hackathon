import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTrackManager } from '../features/tracks/useTrackManager';
import { buildTrackManagerView } from '../features/tracks/managerView';
import { managerSelectionForTrack } from '../features/tracks/managerSelection';
import { coalesceUserPlotTracks, groupTracks, ungroupTracks } from '../lib/userPlotGroups';
import { coalesceComputationalPlotTracks } from '../lib/computationalPlotGroups';
import type { ComputationalPackManifest, TrackSpec } from '../types';

afterEach(cleanup);
const tracks: TrackSpec[] = ['a', 'b'].map((id) => ({ id, name: id, kind: 'signal', color: '#446688', height: 60, source: { type: 'mock' } }));
const records = tracks.map((spec, order) => ({ spec, order, enabled: true }));

describe('workspace track selection', () => {
  it('keeps the property target when filters, expansion and visibility change', () => {
    const { result, rerender } = renderHook(({ items }) => useTrackManager(items, 'all'), { initialProps: { items: buildTrackManagerView(records) } });
    act(() => result.current.setSelectedIds(['a']));
    act(() => { result.current.setQuery('no matches'); result.current.toggleCollection('data-tracks', 'data'); });
    expect(result.current.collections).toHaveLength(0);
    expect(result.current.selectedMemberIds).toEqual(['a']);
    rerender({ items: buildTrackManagerView(records.map((record) => ({ ...record, enabled: false }))) });
    expect(result.current.selectedItems[0].visibility).toBe('hidden');
    expect(result.current.selectedMemberIds).toEqual(['a']);
    rerender({ items: buildTrackManagerView(records.slice(1)) });
    expect(result.current.selectedItems).toEqual([]);
  });

  it('preserves selection and provenance through group and ungroup', () => {
    const { result, rerender } = renderHook(({ items }) => useTrackManager(items), { initialProps: { items: buildTrackManagerView(records) } });
    act(() => result.current.setSelectedIds(['a', 'b']));
    const grouped = groupTracks(records, ['a', 'b'], 'comparison');
    const groupedItems = buildTrackManagerView(grouped);
    rerender({ items: groupedItems });
    expect(result.current.selectedItems).toHaveLength(1);
    expect(result.current.selectedMemberIds).toEqual(['a', 'b']);
    expect(managerSelectionForTrack(coalesceUserPlotTracks(grouped.map((record) => record.spec))[0], groupedItems, grouped)).toEqual(['user-group:comparison']);
    rerender({ items: buildTrackManagerView(ungroupTracks(grouped, ['a', 'b'])) });
    expect(result.current.selectedIds).toEqual(['a', 'b']);
  });

  it('switches explicitly between model and track properties', () => {
    const { result } = renderHook(() => useTrackManager(buildTrackManagerView(records)));
    act(() => result.current.setSelectedIds(['a']));
    act(() => result.current.selectModel('model-a'));
    expect(result.current.selectedMemberIds).toEqual([]);
    expect(result.current.selectedModelId).toBe('model-a');
    act(() => result.current.setSelectedIds(['b']));
    expect(result.current.selectedModelId).toBeNull();
    expect(result.current.selectedMemberIds).toEqual(['b']);
  });

  it('resolves synthesized predictions to the correct instance even when names match', () => {
    const subtracks = ['donor', 'acceptor'].map((id) => ({ id, name: id, kind: 'signal' as const, color: '#556688', height: 60, outputName: id, groupId: 'prediction', groupLabel: 'Prediction' }));
    const pack: ComputationalPackManifest = { schemaVersion: 1, id: 'model', name: 'Model', model: { format: 'onnx', url: '/model.onnx' }, sequenceProvider: { type: 'ucsc', genome: 'hg38' }, subtracks, plotGroups: [{ id: 'pred', label: 'Prediction', subtrackIds: ['donor', 'acceptor'] }] };
    const modelRecords = ['first', 'second'].flatMap((instanceId, index) => subtracks.map((subtrack, order) => ({
      spec: { id: `${instanceId}:${subtrack.id}`, name: subtrack.name, kind: 'signal' as const, color: subtrack.color, height: 60, source: { type: 'computational' as const, instanceId, pack, packUrl: '/model.czpack', subtrack } }, enabled: true, order: index * 2 + order,
    })));
    const items = buildTrackManagerView(modelRecords);
    const plots = coalesceComputationalPlotTracks(modelRecords.map(({ spec }) => spec));
    expect(managerSelectionForTrack(plots[1], items, modelRecords)).toEqual(['model:second:plot:pred']);
    expect(items[1].members.map((member) => member.instanceId)).toEqual(['second', 'second']);
    expect(items[1].members[0].sourceLabel).toBe('Model / Prediction');
    const split = modelRecords.map((record) => ({ ...record, spec: { ...record.spec, plotGrouping: 'split' as const } }));
    const splitItems = buildTrackManagerView(split);
    expect(splitItems).toHaveLength(4);
    expect(managerSelectionForTrack(split[2].spec, splitItems, split)).toEqual(['second:donor']);
  });
});
