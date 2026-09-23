import { SEQUENCE_SECTION_COLORS, subgroupColor } from '../../lib/groupColors';
import type { ComputationalPackManifest, TrackSpec } from '../../types';

/**
 * The track list as rows: the tracks, with a header above each mounted model
 * and, inside a model that has more than one output collection, a header
 * above each collection. So a model reads as a group, and its predictions and
 * attributions as subgroups within it, in the list itself rather than only in
 * a panel.
 *
 * Headers are derived from the rows beneath them, not stored: a model's rows
 * are wherever the user put them, and a header is emitted wherever a run of
 * that model's rows begins. A model with every output hidden has no rows, and
 * so no place; its header goes at the top, where its Outputs button is the way
 * back to it.
 *
 * Above all of that sits one more level once the sequence is edited: the rows
 * re-run on the edited sequence form one section, and the reference strip with
 * everything scored on or aligned to the reference forms another. The two
 * sequence rows themselves are the section markers -- the pinned edited row
 * above the list and the reference strip inside it -- and the edited rows wear
 * the edit colour, so which sequence a row answers for is never a matter of
 * counting rows. (Separate header rows were tried and only repeated what the
 * sequence rows already said, in the wrong places.)
 */

export type SequenceSection = 'edited' | 'reference';

export type TrackGrouping = {
  /** The model instance this row belongs to. */
  instanceId: string;
  /** The model's colour. */
  groupColor: string;
  /** This row's output collection, when the model has more than one. */
  subgroupId?: string;
  subgroupColor?: string;
  /** 1 directly under the model header, 2 under a subgroup header. */
  depth: 1 | 2;
  /** Which sequence this row answers for, once the sequence is edited. */
  section?: SequenceSection;
};

export type TrackListRow =
  | { kind: 'track'; id: string; track: TrackSpec; trackIndex: number; grouping?: TrackGrouping }
  | { kind: 'model-header'; id: string; instanceId: string; groupColor: string }
  | {
      kind: 'subgroup-header';
      id: string;
      instanceId: string;
      subgroupId: string;
      label: string;
      groupColor: string;
      subgroupColor: string;
      /** Rows beneath this header. */
      count: number;
    };

export function trackInstanceId(track: TrackSpec): string | null {
  if (track.source.type !== 'computational') {
    return null;
  }
  return track.source.instanceId ?? `${track.source.pack.id}|${track.source.packUrl}`;
}

/** The pack's output collections in declaration order; a subtrack without one is its own. */
export function packSubgroups(pack: ComputationalPackManifest): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const subtrack of pack.subtracks) {
    const id = subtrack.groupId ?? `output:${subtrack.id}`;
    if (!seen.has(id)) {
      seen.set(id, subtrack.groupLabel ?? subtrack.name);
    }
  }
  return Array.from(seen, ([id, label]) => ({ id, label }));
}

/** The colour of one of a pack's collections, stable whatever is shown. */
export function packSubgroupColor(pack: ComputationalPackManifest, subgroupId: string, groupColor: string): string {
  const subgroups = packSubgroups(pack);
  const index = subgroups.findIndex((subgroup) => subgroup.id === subgroupId);
  return subgroupColor(groupColor, Math.max(0, index), subgroups.length);
}

function subgroupOf(track: TrackSpec): { id: string; label: string } | null {
  if (track.source.type !== 'computational') {
    return null;
  }
  const subtrack = track.source.subtrack;
  return {
    id: subtrack.groupId ?? `output:${subtrack.id}`,
    label: subtrack.groupLabel ?? subtrack.name,
  };
}

/** Rows of a model that is not the plot re-run on an edited sequence. */
function isGroupedModelRow(track: TrackSpec): boolean {
  return track.source.type === 'computational' && track.source.editRole !== 'edited';
}

export function buildTrackListRows(
  tracks: readonly TrackSpec[],
  groupColors: ReadonlyMap<string, string>,
  /** Every mounted model instance, so one with no rows still gets a header. */
  mountedInstanceIds: readonly string[] = [],
): TrackListRow[] {
  const rows: TrackListRow[] = [];
  const emittedInstances = new Set<string>();
  let previousInstance: string | null = null;
  let previousSubgroup: string | null = null;

  // The edited sequence's rows come first in the layout, then the reference
  // strip, then everything else (see editedSequenceTracks.ts).
  let section: SequenceSection | undefined;

  tracks.forEach((track, trackIndex) => {
    if (track.source.type === 'computational' && track.source.editRole === 'edited') {
      section = 'edited';
      rows.push({
        kind: 'track',
        id: track.id,
        track,
        trackIndex,
        grouping: { instanceId: trackInstanceId(track)!, groupColor: SEQUENCE_SECTION_COLORS.edited, depth: 1, section: 'edited' },
      });
      previousInstance = null;
      previousSubgroup = null;
      return;
    }

    if (track.source.type === 'sequence-variant') {
      section = 'reference';
      rows.push({ kind: 'track', id: track.id, track, trackIndex });
      previousInstance = null;
      previousSubgroup = null;
      return;
    }

    if (!isGroupedModelRow(track) || track.source.type !== 'computational') {
      rows.push({ kind: 'track', id: track.id, track, trackIndex });
      previousInstance = null;
      previousSubgroup = null;
      return;
    }

    const instanceId = trackInstanceId(track)!;
    const groupColor = groupColors.get(instanceId) ?? '#7c3aed';
    const subgroups = packSubgroups(track.source.pack);
    const nested = subgroups.length > 1;
    const subgroup = subgroupOf(track);

    if (instanceId !== previousInstance) {
      rows.push({ kind: 'model-header', id: `model-header:${instanceId}:${trackIndex}`, instanceId, groupColor });
      emittedInstances.add(instanceId);
      previousSubgroup = null;
    }

    let grouping: TrackGrouping = { instanceId, groupColor, depth: 1, section };
    if (nested && subgroup) {
      const color = packSubgroupColor(track.source.pack, subgroup.id, groupColor);
      if (subgroup.id !== previousSubgroup) {
        rows.push({
          kind: 'subgroup-header',
          id: `subgroup-header:${instanceId}:${subgroup.id}:${trackIndex}`,
          instanceId,
          subgroupId: subgroup.id,
          label: subgroup.label,
          groupColor,
          subgroupColor: color,
          count: 0,
        });
      }
      grouping = { instanceId, groupColor, subgroupId: subgroup.id, subgroupColor: color, depth: 2, section };
      previousSubgroup = subgroup.id;
    }

    rows.push({ kind: 'track', id: track.id, track, trackIndex, grouping });
    previousInstance = instanceId;
  });

  // Count the rows under each subgroup header.
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind !== 'subgroup-header') {
      continue;
    }
    let count = 0;
    for (let next = index + 1; next < rows.length; next += 1) {
      const candidate = rows[next]!;
      if (candidate.kind !== 'track' || candidate.grouping?.subgroupId !== row.subgroupId || candidate.grouping.instanceId !== row.instanceId) {
        break;
      }
      count += 1;
    }
    row.count = count;
  }

  // Models with nothing shown: a header at the top, so they can be found again.
  const orphans: TrackListRow[] = [];
  for (const instanceId of mountedInstanceIds) {
    if (emittedInstances.has(instanceId)) {
      continue;
    }
    emittedInstances.add(instanceId);
    orphans.push({
      kind: 'model-header',
      id: `model-header:${instanceId}:hidden`,
      instanceId,
      groupColor: groupColors.get(instanceId) ?? '#7c3aed',
    });
  }
  return orphans.length > 0 ? [...orphans, ...rows] : rows;
}

/**
 * Translate a range of list rows into the range of TRACKS it shows, for the
 * consumers that index the track array (load status, prefetch). Headers are
 * skipped; a range that holds only headers reports the nearest track after it.
 */
export function trackRangeForRows(
  rows: readonly TrackListRow[],
  range: { startIndex: number; endIndex: number },
): { startIndex: number; endIndex: number } {
  let start = -1;
  let end = -1;
  for (let index = Math.max(0, range.startIndex); index <= Math.min(rows.length - 1, range.endIndex); index += 1) {
    const row = rows[index]!;
    if (row.kind !== 'track') {
      continue;
    }
    if (start < 0) {
      start = row.trackIndex;
    }
    end = row.trackIndex;
  }
  if (start >= 0) {
    return { startIndex: start, endIndex: end };
  }
  for (let index = Math.max(0, range.endIndex + 1); index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === 'track') {
      return { startIndex: row.trackIndex, endIndex: row.trackIndex };
    }
  }
  return { startIndex: 0, endIndex: 0 };
}
