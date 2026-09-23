import type { ManagedTrackLike } from './computationalFamily';
import { resolveComputationalPlotGroup } from './computationalPlotGroups';
import type { TrackSpec } from '../types';

/**
 * Combined plots the user arranges, and the split/combine state of the plots a
 * pack arranges.
 *
 * A combined row is synthesized fresh on every render from the enabled member
 * specs, so what the user decides has to live on the members: `plotGrouping`
 * says whether a pack-grouped output draws with its group or alone, and
 * `userGroup` puts any signal tracks -- a bigWig, a model output, both -- into
 * one row with one shared axis. The row itself carries its members as a `group`
 * source; the loader fans out to each member's own window, so a member is
 * fetched and cached exactly as it would be on its own.
 */

export type PlotGroupingActionKind = 'split' | 'combine' | 'ungroup';

export type PlotGroupingAction = {
  kind: PlotGroupingActionKind;
  label: string;
  title: string;
};

function computationalInstanceKey(track: TrackSpec): string | null {
  if (track.source.type !== 'computational') {
    return null;
  }
  return track.source.instanceId ?? `${track.source.pack.id}|${track.source.packUrl}`;
}

/** One row for a user group: the members in list order, sharing one axis. */
export function synthesizeUserPlotTrack(members: readonly TrackSpec[]): TrackSpec {
  const first = members[0];
  if (!first?.userGroup) {
    throw new Error('Cannot synthesize a user plot without members.');
  }
  const label = members.find((member) => member.userGroup?.label)?.userGroup?.label;
  return {
    id: `user-plot:${encodeURIComponent(first.userGroup.id)}`,
    name: label ?? members.map((member) => member.name).join(' + '),
    kind: 'signal',
    color: first.color,
    height: Math.max(...members.map((member) => member.height)),
    yScale: first.yScale,
    scaleShape: members.find((member) => member.scaleShape)?.scaleShape,
    // A row of several series has no DNA-height mode; that is a one-series display.
    signalDisplay: 'signal',
    source: { type: 'group', members: [...members] },
  };
}

/**
 * Collapse user-grouped signal tracks into one row each, at the first member's
 * position. A group with a single enabled member draws that member as itself.
 * Runs after the pack-level coalescing, which leaves user-grouped members alone.
 */
export function coalesceUserPlotTracks(tracks: readonly TrackSpec[]): TrackSpec[] {
  const membersByGroup = new Map<string, TrackSpec[]>();
  for (const track of tracks) {
    if (track.kind === 'signal' && track.userGroup) {
      const members = membersByGroup.get(track.userGroup.id);
      if (members) {
        members.push(track);
      } else {
        membersByGroup.set(track.userGroup.id, [track]);
      }
    }
  }

  const emitted = new Set<string>();
  const result: TrackSpec[] = [];
  for (const track of tracks) {
    const groupId = track.kind === 'signal' ? track.userGroup?.id : undefined;
    const members = groupId ? membersByGroup.get(groupId) : undefined;
    if (!groupId || !members || members.length < 2) {
      result.push(track);
      continue;
    }
    if (!emitted.has(groupId)) {
      emitted.add(groupId);
      result.push(synthesizeUserPlotTrack(members));
    }
  }
  return result;
}

/** What the grouping button on a rendered row does, if it has one. */
export function plotGroupingAction(track: TrackSpec): PlotGroupingAction | null {
  if (track.kind !== 'signal') {
    return null;
  }
  if (track.source.type === 'group') {
    return { kind: 'ungroup', label: 'UNGROUP', title: 'Draw each of these tracks as its own row again.' };
  }
  if (track.source.type !== 'computational') {
    return null;
  }
  if ((track.source.seriesSubtrackIds?.length ?? 1) > 1) {
    return { kind: 'split', label: 'SPLIT', title: 'Draw each output in this plot as its own row.' };
  }
  if (
    track.plotGrouping === 'split' &&
    resolveComputationalPlotGroup(track.source.pack, track.source.subtrack)
  ) {
    return { kind: 'combine', label: 'COMBINE', title: 'Draw this output together with the rest of its plot group again.' };
  }
  return null;
}

/** Apply a row's grouping button to the managed records it stands for. */
export function applyPlotGroupingAction(
  records: readonly ManagedTrackLike[],
  track: TrackSpec,
  kind: PlotGroupingActionKind,
): ManagedTrackLike[] {
  if (kind === 'ungroup') {
    const ids = new Set(track.source.type === 'group' ? track.source.members.map((member) => member.id) : [track.id]);
    return records.map((record) =>
      ids.has(record.spec.id) && record.spec.userGroup
        ? { ...record, spec: { ...record.spec, userGroup: undefined } }
        : record,
    );
  }

  if (track.source.type !== 'computational') {
    return [...records];
  }
  const instance = computationalInstanceKey(track);

  if (kind === 'split') {
    const outputIds = new Set(track.source.seriesSubtrackIds ?? [track.source.subtrack.id]);
    return records.map((record) =>
      record.spec.source.type === 'computational' &&
      computationalInstanceKey(record.spec) === instance &&
      outputIds.has(record.spec.source.subtrack.id)
        ? { ...record, spec: { ...record.spec, plotGrouping: 'split' } }
        : record,
    );
  }

  const plotGroup = resolveComputationalPlotGroup(track.source.pack, track.source.subtrack);
  if (!plotGroup) {
    return [...records];
  }
  return records.map((record) =>
    record.spec.source.type === 'computational' &&
    computationalInstanceKey(record.spec) === instance &&
    resolveComputationalPlotGroup(record.spec.source.pack, record.spec.source.subtrack)?.id === plotGroup.id
      ? { ...record, spec: { ...record.spec, plotGrouping: undefined } }
      : record,
  );
}

/** Put the named signal tracks into one combined plot. Fewer than two eligible: no change. */
export function groupTracks(
  records: readonly ManagedTrackLike[],
  trackIds: readonly string[],
  groupId: string,
): ManagedTrackLike[] {
  const wanted = new Set(trackIds);
  const eligible = records.filter((record) => wanted.has(record.spec.id) && record.spec.kind === 'signal');
  if (eligible.length < 2) {
    return [...records];
  }
  return records.map((record) =>
    wanted.has(record.spec.id) && record.spec.kind === 'signal'
      ? { ...record, spec: { ...record.spec, userGroup: { id: groupId }, plotGrouping: undefined } }
      : record,
  );
}

/** Take the named tracks out of whatever user groups they are in. */
export function ungroupTracks(records: readonly ManagedTrackLike[], trackIds: readonly string[]): ManagedTrackLike[] {
  const wanted = new Set(trackIds);
  return records.map((record) =>
    wanted.has(record.spec.id) && record.spec.userGroup
      ? { ...record, spec: { ...record.spec, userGroup: undefined } }
      : record,
  );
}

/**
 * Renaming a member of a user group names the group. Returns null when the
 * track is not in one, so the caller can rename the track itself.
 */
export function renameUserGroup(
  records: readonly ManagedTrackLike[],
  trackId: string,
  name: string,
): ManagedTrackLike[] | null {
  const groupId = records.find((record) => record.spec.id === trackId)?.spec.userGroup?.id;
  if (!groupId) {
    return null;
  }
  return records.map((record) =>
    record.spec.userGroup?.id === groupId
      ? { ...record, spec: { ...record.spec, userGroup: { id: groupId, label: name } } }
      : record,
  );
}
