import type {
  ComputationalPackManifest,
  ComputationalPlotGroupSpec,
  ComputationalSubtrackSpec,
  TrackSource,
  TrackSpec,
} from '../types';

type ComputationalSource = Extract<TrackSource, { type: 'computational' }>;

export type ResolvedComputationalPlotGroup = ComputationalPlotGroupSpec & {
  source: 'pack' | 'subtrack';
};

/** Pack-level composition is preferred; per-subtrack metadata is a compact fallback. */
export function resolveComputationalPlotGroup(
  pack: ComputationalPackManifest,
  subtrack: ComputationalSubtrackSpec,
): ResolvedComputationalPlotGroup | null {
  const explicitPackGroup = pack.plotGroups?.find((group) =>
    group.subtrackIds?.includes(subtrack.id),
  );
  if (explicitPackGroup) {
    return { ...explicitPackGroup, source: 'pack' };
  }
  if (subtrack.groupId) {
    const collectionPackGroup = pack.plotGroups?.find((group) =>
      group.groupIds?.includes(subtrack.groupId as string),
    );
    if (collectionPackGroup) {
      return { ...collectionPackGroup, source: 'pack' };
    }
  }

  if (!subtrack.plotGroupId) {
    return null;
  }

  return {
    id: subtrack.plotGroupId,
    label: subtrack.plotGroupLabel ?? subtrack.groupLabel ?? subtrack.name,
    groupIds: subtrack.groupId ? [subtrack.groupId] : [],
    source: 'subtrack',
  };
}

/** Resolve the ordered display series carried by a computational track source. */
export function resolveComputationalTrackSubtracks(
  source: ComputationalSource,
): ComputationalSubtrackSpec[] {
  const ids = source.seriesSubtrackIds;
  if (!ids || ids.length === 0) {
    return [source.subtrack];
  }

  const byId = new Map(source.pack.subtracks.map((subtrack) => [subtrack.id, subtrack]));
  const resolved: ComputationalSubtrackSpec[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    const subtrack = byId.get(id);
    if (!subtrack) {
      throw new Error(`Computational model "${source.pack.name}" does not define subtrack "${id}".`);
    }
    seen.add(id);
    resolved.push(subtrack);
  }

  if (!seen.has(source.subtrack.id)) {
    throw new Error(
      `Computational plot series must include its primary subtrack "${source.subtrack.id}".`,
    );
  }
  return resolved;
}

export function resolveComputationalSeriesLineStyle(
  source: ComputationalSource,
  subtrack: ComputationalSubtrackSpec,
): 'solid' | 'dashed' {
  const plotGroup = resolveComputationalPlotGroup(source.pack, subtrack);
  if (
    plotGroup?.source === 'pack' &&
    plotGroup.dashedSubtrackIds?.includes(subtrack.id)
  ) {
    return 'dashed';
  }
  if (
    subtrack.groupId &&
    plotGroup?.source === 'pack' &&
    plotGroup.dashedGroupIds?.includes(subtrack.groupId)
  ) {
    return 'dashed';
  }
  return subtrack.lineStyle ?? 'solid';
}

type PlotMember = {
  index: number;
  track: TrackSpec;
  source: ComputationalSource;
  plotGroup: ResolvedComputationalPlotGroup;
};

function computationalInstanceKey(source: ComputationalSource): string {
  return source.instanceId ?? `${source.pack.id}|${source.packUrl}`;
}

function plotKey(source: ComputationalSource, plotGroupId: string): string {
  return JSON.stringify([computationalInstanceKey(source), plotGroupId]);
}

function compatiblePlotMembers(members: readonly PlotMember[]): boolean {
  const first = members[0];
  if (!first) {
    return false;
  }
  return members.every(({ track, source }) =>
    track.kind === first.track.kind &&
    source.pack.id === first.source.pack.id &&
    source.packUrl === first.source.packUrl,
  );
}

function orderedSeriesIds(
  members: readonly PlotMember[],
  plotGroup: ResolvedComputationalPlotGroup,
): string[] {
  const enabledIds = new Set<string>();
  for (const { source } of members) {
    for (const subtrack of resolveComputationalTrackSubtracks(source)) {
      enabledIds.add(subtrack.id);
    }
  }

  const first = members[0];
  if (!first) {
    return [];
  }

  const ordered: string[] = [];
  if (plotGroup.source === 'pack') {
    for (const subtrackId of plotGroup.subtrackIds ?? []) {
      if (enabledIds.delete(subtrackId)) {
        ordered.push(subtrackId);
      }
    }
    for (const groupId of plotGroup.groupIds ?? []) {
      for (const subtrack of first.source.pack.subtracks) {
        if (subtrack.groupId === groupId && enabledIds.delete(subtrack.id)) {
          ordered.push(subtrack.id);
        }
      }
    }
  }

  // Preserve logical track order for fallback groups and for any series omitted
  // from a pack-level group declaration.
  for (const { source } of members) {
    for (const subtrack of resolveComputationalTrackSubtracks(source)) {
      if (enabledIds.delete(subtrack.id)) {
        ordered.push(subtrack.id);
      }
    }
  }
  return ordered;
}

function synthesizePlotTrack(members: readonly PlotMember[]): TrackSpec {
  const first = members[0];
  if (!first) {
    throw new Error('Cannot synthesize an empty computational plot group.');
  }

  const seriesSubtrackIds = orderedSeriesIds(members, first.plotGroup);
  const primaryId = seriesSubtrackIds[0] ?? first.source.subtrack.id;
  const primarySubtrack = first.source.pack.subtracks.find((subtrack) => subtrack.id === primaryId)
    ?? first.source.subtrack;
  const instanceKey = computationalInstanceKey(first.source);
  const height = first.plotGroup.height ?? Math.max(...members.map(({ track }) => track.height));

  return {
    id: `computational-plot:${encodeURIComponent(instanceKey)}:${encodeURIComponent(first.plotGroup.id)}`,
    name: first.plotGroup.label,
    kind: first.track.kind,
    color: primarySubtrack.color,
    height,
    yScale: first.track.yScale,
    // The plot row is synthesized fresh on every render, so a per-track display
    // choice has to be carried over from the member it was set on.
    scaleShape: members.find(({ track }) => track.scaleShape)?.track.scaleShape,
    signalDisplay: first.track.signalDisplay,
    source: {
      ...first.source,
      subtrack: primarySubtrack,
      seriesSubtrackIds,
    },
  };
}

/**
 * Collapse enabled computational outputs into manifest-declared plot rows.
 * Ordinary tracks and computational outputs without plot metadata are returned
 * unchanged. Each synthesized plot occupies its first member's input position.
 */
export function coalesceComputationalPlotTracks(tracks: readonly TrackSpec[]): TrackSpec[] {
  const membersByKey = new Map<string, PlotMember[]>();
  const memberKeyByIndex = new Map<number, string>();

  tracks.forEach((track, index) => {
    if (track.source.type !== 'computational') {
      return;
    }
    // An output drawn on its own, or claimed by a user-defined plot, is not
    // part of its pack's plot for as long as that lasts.
    if (track.plotGrouping === 'split' || track.userGroup) {
      return;
    }
    const plotGroup = resolveComputationalPlotGroup(track.source.pack, track.source.subtrack);
    if (!plotGroup) {
      return;
    }
    const key = plotKey(track.source, plotGroup.id);
    const member = { index, track, source: track.source, plotGroup };
    const existing = membersByKey.get(key);
    if (existing) {
      existing.push(member);
    } else {
      membersByKey.set(key, [member]);
    }
    memberKeyByIndex.set(index, key);
  });

  const result: TrackSpec[] = [];
  tracks.forEach((track, index) => {
    const key = memberKeyByIndex.get(index);
    if (!key) {
      result.push(track);
      return;
    }

    const members = membersByKey.get(key) ?? [];
    if (!compatiblePlotMembers(members)) {
      result.push(track);
      return;
    }
    if (members[0]?.index === index) {
      result.push(synthesizePlotTrack(members));
    }
  });
  return result;
}
