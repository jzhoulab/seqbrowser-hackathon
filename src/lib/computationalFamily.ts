import { catalogFamilyId, modelOutputLabel } from '../features/models/catalog';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, TrackSpec } from '../types';

export type ManagedTrackLike = {
  spec: TrackSpec;
  enabled: boolean;
  order: number;
};

export type ComputationalTrackInput = {
  pack: ComputationalPackManifest;
  sourceUrl: string;
  instanceId: string;
  subtrack: ComputationalSubtrackSpec;
  trackId: string;
  enabled: boolean;
};

/** One output of a mounted pack as a track record. The single place that shape is decided. */
export function buildComputationalTrack({
  pack,
  sourceUrl,
  instanceId,
  subtrack,
  trackId,
  enabled,
}: ComputationalTrackInput): Omit<ManagedTrackLike, 'order'> {
  return {
    spec: {
      id: trackId,
      name: modelOutputLabel(pack.id, subtrack.id, subtrack.name),
      kind: subtrack.kind,
      color: subtrack.color,
      height: subtrack.height,
      signalDisplay: subtrack.defaultSignalDisplay,
      // A pinned axis is a property of the individual output, declared in the
      // manifest; a signed output must never inherit one from its neighbours.
      yScale: subtrack.fixedScale
        ? { mode: 'fixed' as const, min: subtrack.fixedScale.min, max: subtrack.fixedScale.max }
        : subtrack.defaultSignalDisplay === 'sequence' && subtrack.groupId
          ? { mode: 'linked' as const, groupId: `${instanceId}:${subtrack.groupId}` }
          : undefined,
      source: {
        type: 'computational' as const,
        instanceId,
        packUrl: sourceUrl,
        pack,
        subtrack,
      },
    },
    enabled,
  };
}

/**
 * Swap a mounted catalog family to another of its checkpoints.
 *
 * Outputs the two packs share keep their track record, so what the user showed,
 * hid or re-styled carries over. Outputs the new checkpoint lacks are dropped, and
 * outputs it adds are mounted next to the family: shown if the user had shown the
 * collection they belong to (the branchpoint ISM row appears alongside the donor
 * and acceptor ISM rows the user turned on), otherwise with the manifest's
 * default. This used to map records by output id and stop there, which was fine
 * while every checkpoint had identical outputs and made the whole family
 * disappear the moment one had a third.
 */
export function replaceComputationalFamilyTracks(
  records: readonly ManagedTrackLike[],
  pack: ComputationalPackManifest,
  sourceUrl: string,
  isFamily: (packId: string) => boolean,
  nextTrackId: (subtrack: ComputationalSubtrackSpec) => string,
): ManagedTrackLike[] {
  const inFamily = (record: ManagedTrackLike) =>
    record.spec.source.type === 'computational' && isFamily(record.spec.source.pack.id);
  const sorted = [...records].sort((left, right) => left.order - right.order);
  const family = sorted.filter(inFamily);
  if (family.length === 0) {
    return [...records];
  }

  const firstSource = family[0]!.spec.source;
  const instanceId =
    firstSource.type === 'computational'
      ? firstSource.instanceId ?? `catalog_${catalogFamilyId(pack.id)}`
      : `catalog_${catalogFamilyId(pack.id)}`;
  const nextSubtracks = new Map(pack.subtracks.map((subtrack) => [subtrack.id, subtrack]));
  // Whether the user had any output of each collection shown before the swap.
  const collectionShown = new Map<string, boolean>();
  for (const record of family) {
    if (record.spec.source.type !== 'computational') {
      continue;
    }
    const groupId = record.spec.source.subtrack.groupId;
    if (groupId !== undefined) {
      collectionShown.set(groupId, (collectionShown.get(groupId) ?? false) || record.enabled);
    }
  }
  const kept = new Set<string>();
  const next: ManagedTrackLike[] = [];
  let lastFamilyIndex = -1;

  for (const record of sorted) {
    if (!inFamily(record) || record.spec.source.type !== 'computational') {
      next.push(record);
      continue;
    }
    const nextSubtrack = nextSubtracks.get(record.spec.source.subtrack.id);
    if (!nextSubtrack) {
      continue;
    }
    kept.add(nextSubtrack.id);
    next.push({
      ...record,
      spec: {
        ...record.spec,
        name: modelOutputLabel(pack.id, nextSubtrack.id, nextSubtrack.name),
        color: nextSubtrack.color,
        height: nextSubtrack.height,
        source: {
          ...record.spec.source,
          instanceId,
          packUrl: sourceUrl,
          pack,
          subtrack: nextSubtrack,
        },
      },
    });
    lastFamilyIndex = next.length - 1;
  }

  const added = pack.subtracks
    .filter((subtrack) => !kept.has(subtrack.id))
    .map((subtrack) => ({
      ...buildComputationalTrack({
        pack,
        sourceUrl,
        instanceId,
        subtrack,
        trackId: nextTrackId(subtrack),
        enabled:
          (subtrack.groupId !== undefined ? collectionShown.get(subtrack.groupId) : undefined) ??
          subtrack.defaultVisible !== false,
      }),
      order: 0,
    }));
  next.splice(lastFamilyIndex + 1, 0, ...added);

  // Renumber from the top: relative order is what the list means.
  return next.map((record, index) => ({ ...record, order: index }));
}
