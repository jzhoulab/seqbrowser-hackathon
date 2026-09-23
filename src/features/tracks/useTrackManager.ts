import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { TrackManagerViewItem } from './managerView';
import type { TrackManagerPanelItem } from './managerControls';

type VisibilityFilter = 'shown' | 'hidden' | 'all';
type OriginFilter = 'all' | 'data' | 'model';

export function itemMembers(item: TrackManagerViewItem): string[] {
  return item.memberIds.length > 0 ? item.memberIds : [item.id];
}

export function uniqueMembers(items: readonly TrackManagerViewItem[]): string[] {
  return Array.from(new Set(items.flatMap(itemMembers)));
}

function filterVisibility(item: TrackManagerViewItem, filter: VisibilityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'shown') return item.visibility !== 'hidden';
  return item.visibility === 'hidden';
}

function sourceMatches(item: TrackManagerViewItem, filter: OriginFilter): boolean {
  return filter === 'all' || item.origin === filter;
}

/** Selection belongs to the workspace and survives filtering, folding and docking. */
export function useTrackManager(items: TrackManagerPanelItem[], initialVisibility: VisibilityFilter = 'shown') {
  const sortedItems = useMemo<TrackManagerViewItem[]>(() => items.map((item) => {
    const enabledCount = item.enabledCount ?? (item.enabled ? 1 : 0);
    const totalCount = item.totalCount ?? 1;
    const visibility = item.visibility ?? (enabledCount <= 0 ? 'hidden' : enabledCount >= totalCount ? 'shown' : 'partial');
    return {
      ...item,
      memberIds: item.memberIds ?? [item.id],
      members: item.members ?? [{ id: item.id, name: item.name, color: item.color ?? 'var(--accent)' }],
      enabledCount,
      totalCount,
      visibility,
      color: item.color ?? 'var(--accent)',
      origin: item.origin ?? 'data',
      collectionId: item.collectionId ?? 'data-tracks',
      collectionName: item.collectionName ?? 'Data tracks',
      sourceLabel: item.sourceLabel ?? (item.kind === 'signal' ? 'Signal track' : 'Annotation track'),
      renameable: item.renameable ?? true,
    };
  }).sort((a, b) => a.order - b.order), [items]);
  const [query, setQuery] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>(initialVisibility);
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [expandedCollections, setExpandedCollections] = useState<Record<string, boolean>>({});
  // Member identity survives combining/splitting visual rows and hiding outputs.
  const [selectedMemberKeys, setSelectedMemberKeys] = useState<string[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const selectedIds = useMemo(() => sortedItems.filter((item) => item.memberIds.some((id) => selectedMemberKeys.includes(id))).map((item) => item.id), [sortedItems, selectedMemberKeys]);
  const setSelectedIds = useCallback((next: SetStateAction<string[]>) => {
    setSelectedModelId(null);
    setSelectedMemberKeys((previous) => {
      const previousIds = sortedItems.filter((item) => item.memberIds.some((id) => previous.includes(id))).map((item) => item.id);
      const ids = typeof next === 'function' ? next(previousIds) : next;
      return uniqueMembers(sortedItems.filter((item) => ids.includes(item.id)));
    });
  }, [sortedItems]);
  const selectModel = useCallback((id: string) => {
    setSelectedMemberKeys([]);
    setSelectedModelId(id);
  }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedNames, setEditedNames] = useState<Record<string, string>>({});
  const [fixedMin, setFixedMin] = useState('0');
  const [fixedMax, setFixedMax] = useState('1');
  const [showFixedInputs, setShowFixedInputs] = useState(false);
  const selectResultsRef = useRef<HTMLInputElement>(null);

  const revealItems = useCallback((ids: string[]) => {
    setQuery('');
    setVisibilityFilter('all');
    setOriginFilter('all');
    setExpandedCollections((previous) => ({
      ...previous,
      ...Object.fromEntries(sortedItems.filter((item) => ids.includes(item.id)).map((item) => [item.collectionId, true])),
    }));
    setSelectedIds(ids);
  }, [sortedItems, setSelectedIds]);

  const normalizedQuery = query.trim().toLowerCase();
  const matchingItems = useMemo(
    () => sortedItems.filter((item) => {
      if (!filterVisibility(item, visibilityFilter) || !sourceMatches(item, originFilter)) return false;
      if (!normalizedQuery) return true;
      return [item.name, item.collectionName, item.sourceLabel, item.kind]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    }),
    [normalizedQuery, originFilter, sortedItems, visibilityFilter],
  );

  const collections = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; origin: 'data' | 'model'; items: TrackManagerViewItem[] }>();
    for (const item of matchingItems) {
      const existing = byId.get(item.collectionId);
      if (existing) existing.items.push(item);
      else byId.set(item.collectionId, {
        id: item.collectionId,
        name: item.collectionName,
        origin: item.origin,
        items: [item],
      });
    }
    return Array.from(byId.values());
  }, [matchingItems]);

  const collectionIsExpanded = (collection: { id: string; origin: 'data' | 'model' }) => {
    if (normalizedQuery) return true;
    // Data tracks and the user's own combined plots start open; a model's many
    // outputs start folded.
    return expandedCollections[collection.id] ?? (collection.origin === 'data' || collection.id === 'user-groups');
  };

  const selectableItems = useMemo(
    () => collections.flatMap((collection) => collectionIsExpanded(collection) ? collection.items : []),
    // expansion overrides are intentionally part of the manager's actionable result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collections, expandedCollections, normalizedQuery],
  );
  const selectableIdSet = useMemo(() => new Set(selectableItems.map((item) => item.id)), [selectableItems]);
  const selectedItems = useMemo(
    () => sortedItems.filter((item) => selectedIds.includes(item.id)),
    [sortedItems, selectedIds],
  );
  const selectedSignalItems = useMemo(
    () => selectedItems.filter((item) => item.kind === 'signal'),
    [selectedItems],
  );
  const selectedMemberIds = useMemo(() => uniqueMembers(selectedItems), [selectedItems]);
  const selectedSignalMemberIds = useMemo(() => uniqueMembers(selectedSignalItems), [selectedSignalItems]);
  const selectedIdSet = useMemo(() => new Set(selectedItems.map((item) => item.id)), [selectedItems]);
  const allResultsSelected = selectableItems.length > 0 && selectableItems.every((item) => selectedIdSet.has(item.id));
  const someResultsSelected = selectableItems.some((item) => selectedIdSet.has(item.id)) && !allResultsSelected;

  useEffect(() => {
    if (selectResultsRef.current) selectResultsRef.current.indeterminate = someResultsSelected;
  }, [someResultsSelected]);

  useEffect(() => {
    setSelectedMemberKeys((previous) => {
      const next = previous.filter((id) => sortedItems.some((item) => item.memberIds.includes(id)));
      return next.length === previous.length ? previous : next;
    });
  }, [sortedItems]);

  const parsedFixedMin = fixedMin.trim() === '' ? Number.NaN : Number(fixedMin);
  const parsedFixedMax = fixedMax.trim() === '' ? Number.NaN : Number(fixedMax);
  const fixedScaleIsValid = Number.isFinite(parsedFixedMin) && Number.isFinite(parsedFixedMax) && parsedFixedMin < parsedFixedMax;
  const shownViewCount = sortedItems.filter((item) => item.visibility !== 'hidden').length;
  const shownOutputCount = sortedItems.reduce((sum, item) => sum + item.enabledCount, 0);
  const totalOutputCount = sortedItems.reduce((sum, item) => sum + item.totalCount, 0);
  const allIds = sortedItems.map((item) => item.id);

  const toggleCollection = (id: string, origin: 'data' | 'model') => {
    const current = expandedCollections[id] ?? (origin === 'data' || id === 'user-groups');
    setExpandedCollections((previous) => ({ ...previous, [id]: !current }));
  };

  return {
    selectedModelId, selectModel, revealItems,
    sortedItems, query, setQuery, visibilityFilter, setVisibilityFilter, originFilter, setOriginFilter,
    collections, collectionIsExpanded, toggleCollection, selectableItems, selectableIdSet,
    selectedItems, selectedSignalItems, selectedMemberIds, selectedSignalMemberIds, selectedIdSet,
    selectedIds, setSelectedIds, allResultsSelected, selectResultsRef,
    editingId, setEditingId, editedNames, setEditedNames,
    fixedMin, setFixedMin, fixedMax, setFixedMax, showFixedInputs, setShowFixedInputs,
    parsedFixedMin, parsedFixedMax, fixedScaleIsValid,
    shownViewCount, shownOutputCount, totalOutputCount, allIds,
  };
}

export type TrackManagerController = ReturnType<typeof useTrackManager>;
