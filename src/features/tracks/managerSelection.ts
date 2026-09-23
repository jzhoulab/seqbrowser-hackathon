import { trackInstanceId } from './listRows';
import type { ManagerTrackRecord, TrackManagerViewItem } from './managerView';
import type { TrackSpec } from '../../types';

/** Resolve a plotted row through its source identity, including synthesized plots. */
export function renderedTrackMemberIds(track: TrackSpec, records: readonly ManagerTrackRecord[]): string[] {
  if (track.source.type === 'group') {
    return track.source.members.flatMap((member) => renderedTrackMemberIds(member, records));
  }
  if (track.source.type !== 'computational') return [track.id];
  const instanceId = trackInstanceId(track);
  const outputs = new Set(track.source.seriesSubtrackIds ?? [track.source.subtrack.id]);
  return records.filter(({ spec }) => spec.source.type === 'computational'
    && trackInstanceId(spec) === instanceId
    && outputs.has(spec.source.subtrack.id)).map(({ spec }) => spec.id);
}

export function managerSelectionForTrack(track: TrackSpec, items: readonly TrackManagerViewItem[], records: readonly ManagerTrackRecord[]): string[] {
  const members = new Set(renderedTrackMemberIds(track, records));
  return items.filter((item) => item.memberIds.some((id) => members.has(id))).map((item) => item.id);
}
