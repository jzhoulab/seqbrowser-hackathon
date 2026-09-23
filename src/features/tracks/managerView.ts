import { resolveComputationalPlotGroup } from '../../lib/computationalPlotGroups';
import { packSubgroups } from './listRows';
import type { TrackScaleConfig } from '../../lib/signalScale';
import type { SignalDisplayMode, TrackKind, TrackSpec } from '../../types';

export type TrackManagerVisibility = 'shown' | 'partial' | 'hidden';

export type TrackManagerMember = {
  sourceLabel?: string;
  instanceId?: string;
  id: string;
  name: string;
  color: string;
};

export type TrackManagerViewItem = {
  id: string;
  name: string;
  memberIds: string[];
  /** The tracks behind the row, in order; one entry for a plain track. */
  members: TrackManagerMember[];
  enabled: boolean;
  enabledCount: number;
  totalCount: number;
  visibility: TrackManagerVisibility;
  order: number;
  kind: TrackKind;
  color: string;
  yScale?: TrackScaleConfig;
  scaleMixed?: boolean;
  signalDisplay?: SignalDisplayMode;
  displayMixed?: boolean;
  origin: 'data' | 'model';
  collectionId: string;
  collectionName: string;
  sourceLabel: string;
  renameable: boolean;
  /** A combined row: arranged by the pack's manifest, or by the user. */
  plotKind?: 'pack' | 'user';
  /** The model instance behind a model row, for its group colour. */
  instanceId?: string;
  /**
   * The output collection a model row belongs to, when its pack has more than
   * one: the Tracks panel nests the model's rows under their collections the
   * way the track list does. Index and count give the collection its shade.
   */
  subgroupId?: string;
  subgroupLabel?: string;
  subgroupIndex?: number;
  subgroupCount?: number;
};

export type ManagerTrackRecord = {
  spec: TrackSpec;
  enabled: boolean;
  order: number;
};

type MutableViewItem = Omit<TrackManagerViewItem, 'enabled' | 'enabledCount' | 'totalCount' | 'visibility'> & {
  enabledCount: number;
  totalCount: number;
  scales: Array<TrackScaleConfig | undefined>;
  displays: Array<SignalDisplayMode | undefined>;
};

function computationalInstanceId(track: TrackSpec): string {
  if (track.source.type !== 'computational') {
    return '';
  }
  return track.source.instanceId ?? `${track.source.pack.id}|${track.source.packUrl}`;
}

function stableValue<T>(values: readonly T[]): { value: T | undefined; mixed: boolean } {
  const first = values[0];
  const firstKey = JSON.stringify(first);
  const mixed = values.some((value) => JSON.stringify(value) !== firstKey);
  return { value: mixed ? undefined : first, mixed };
}

function visibilityFor(enabledCount: number, totalCount: number): TrackManagerVisibility {
  if (enabledCount <= 0) {
    return 'hidden';
  }
  return enabledCount >= totalCount ? 'shown' : 'partial';
}

function ordinarySourceLabel(track: TrackSpec): string {
  switch (track.source.type) {
    case 'bigwig':
      return 'BigWig signal';
    case 'bigbed':
      return 'BigBed annotation';
    default:
      return track.kind === 'signal' ? 'Signal track' : 'Annotation track';
  }
}

function managerMember(track: TrackSpec): TrackManagerMember {
  const source = track.source;
  return {
    id: track.id, name: track.name, color: track.color,
    sourceLabel: source.type === 'computational'
      ? [source.pack.name, source.subtrack.groupLabel].filter(Boolean).join(' / ')
      : ordinarySourceLabel(track),
    instanceId: source.type === 'computational' ? computationalInstanceId(track) : undefined,
  };
}

/**
 * Build the manager's visual stack. Computational plot members become one row,
 * matching the canvas, while independently selectable outputs remain individual.
 */
export function buildTrackManagerView(records: readonly ManagerTrackRecord[]): TrackManagerViewItem[] {
  const sorted = [...records].sort((left, right) => left.order - right.order);
  const byKey = new Map<string, MutableViewItem>();

  for (const record of sorted) {
    const { spec } = record;
    if (spec.kind === 'signal' && spec.userGroup) {
      // A user-defined combined plot is one row, whatever its members are.
      const key = `user-group:${spec.userGroup.id}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.memberIds.push(spec.id);
        existing.members.push(managerMember(spec));
        existing.enabledCount += record.enabled ? 1 : 0;
        existing.totalCount += 1;
        existing.order = Math.min(existing.order, record.order);
        existing.scales.push(spec.yScale);
        existing.displays.push(spec.signalDisplay);
        continue;
      }
      byKey.set(key, {
        id: key,
        name: spec.userGroup.label ?? '',
        memberIds: [spec.id],
        members: [managerMember(spec)],
        order: record.order,
        kind: spec.kind,
        color: spec.color,
        yScale: spec.yScale,
        signalDisplay: spec.signalDisplay,
        origin: spec.source.type === 'computational' ? 'model' : 'data',
        collectionId: 'user-groups',
        collectionName: 'Combined plots',
        sourceLabel: 'Combined plot',
        renameable: true,
        plotKind: 'user',
        enabledCount: record.enabled ? 1 : 0,
        totalCount: 1,
        scales: [spec.yScale],
        displays: [spec.signalDisplay],
      });
      continue;
    }

    if (spec.source.type !== 'computational') {
      const item: MutableViewItem = {
        id: spec.id,
        name: spec.name,
        memberIds: [spec.id],
        order: record.order,
        kind: spec.kind,
        color: spec.color,
        yScale: spec.yScale,
        signalDisplay: spec.signalDisplay,
        origin: 'data',
        collectionId: 'data-tracks',
        collectionName: 'Data tracks',
        sourceLabel: ordinarySourceLabel(spec),
        renameable: true,
        enabledCount: record.enabled ? 1 : 0,
        totalCount: 1,
        scales: [spec.yScale],
        displays: [spec.signalDisplay],
        members: [managerMember(spec)],
      };
      byKey.set(`track:${spec.id}`, item);
      continue;
    }

    const source = spec.source;
    const instanceId = computationalInstanceId(spec);
    const plotGroup = spec.plotGrouping === 'split' ? null : resolveComputationalPlotGroup(source.pack, source.subtrack);
    const key = plotGroup
      ? `model:${instanceId}:plot:${plotGroup.id}`
      : `model:${instanceId}:output:${spec.id}`;
    const existing = byKey.get(key);
    const subgroups = packSubgroups(source.pack);
    const subgroupId = source.subtrack.groupId ?? `output:${source.subtrack.id}`;
    const subgroupIndex = subgroups.findIndex((subgroup) => subgroup.id === subgroupId);
    const nesting = subgroups.length > 1
      ? {
          instanceId,
          subgroupId,
          subgroupLabel: subgroups[subgroupIndex]?.label ?? source.subtrack.groupLabel ?? source.subtrack.name,
          subgroupIndex: Math.max(0, subgroupIndex),
          subgroupCount: subgroups.length,
        }
      : { instanceId };

    if (existing) {
      existing.memberIds.push(spec.id);
      existing.members.push(managerMember(spec));
      existing.enabledCount += record.enabled ? 1 : 0;
      existing.totalCount += 1;
      existing.order = Math.min(existing.order, record.order);
      existing.scales.push(spec.yScale);
      existing.displays.push(spec.signalDisplay);
      continue;
    }

    byKey.set(key, {
      id: plotGroup ? key : spec.id,
      name: plotGroup?.label ?? spec.name,
      memberIds: [spec.id],
      order: record.order,
      kind: spec.kind,
      color: spec.color,
      yScale: spec.yScale,
      signalDisplay: spec.signalDisplay,
      origin: 'model',
      collectionId: `model:${instanceId}`,
      collectionName: source.pack.name,
      sourceLabel: plotGroup
        ? 'Composite model plot'
        : source.subtrack.groupLabel ?? source.subtrack.role ?? 'Model output',
      renameable: !plotGroup,
      plotKind: plotGroup ? 'pack' : undefined,
      ...nesting,
      enabledCount: record.enabled ? 1 : 0,
      totalCount: 1,
      scales: [spec.yScale],
      displays: [spec.signalDisplay],
      members: [managerMember(spec)],
    });
  }

  return Array.from(byKey.values())
    .map((item) => {
      const scale = stableValue(item.scales);
      const display = stableValue(item.displays);
      const visibility = visibilityFor(item.enabledCount, item.totalCount);
      const { scales, displays, ...viewItem } = item;
      void scales;
      void displays;
      return {
        ...viewItem,
        // An unnamed user group is called after its members.
        name: viewItem.name || viewItem.members.map((member) => member.name).join(' + '),
        enabled: visibility === 'shown',
        visibility,
        yScale: scale.value,
        scaleMixed: scale.mixed,
        signalDisplay: display.value,
        displayMixed: display.mixed,
      };
    })
    .sort((left, right) => left.order - right.order);
}
