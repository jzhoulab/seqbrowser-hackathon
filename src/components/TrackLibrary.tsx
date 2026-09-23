import type { CSSProperties } from 'react';
import type { TrackManagerController } from '../features/tracks/useTrackManager';
import { itemMembers } from '../features/tracks/useTrackManager';
import type { TrackManagerViewItem } from '../features/tracks/managerView';
import type { TrackManagerActions } from '../features/tracks/managerControls';
import { subgroupColor } from '../lib/groupColors';
import { stackedSwatch } from '../lib/seriesSwatch';

function compactScaleValue(value: number): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 10_000 || magnitude < 0.001) return value.toExponential(1);
  return String(Number(value.toPrecision(3)));
}

function scaleStatus(item: TrackManagerViewItem): { label: string; accessibleLabel: string; title?: string } | null {
  if (item.kind !== 'signal') return null;
  if (item.scaleMixed) {
    return { label: 'MIXED SCALE', accessibleLabel: `${item.name} uses mixed scales` };
  }

  const scale = item.yScale ?? { mode: 'auto' as const };
  if (scale.mode === 'linked') {
    return {
      label: 'SHARED',
      accessibleLabel: `${item.name} scale: shared`,
      title: `Shared scale group ${scale.groupId}`,
    };
  }
  if (scale.mode === 'fixed') {
    const range = `${compactScaleValue(scale.min)}…${compactScaleValue(scale.max)}`;
    return {
      label: `FIXED ${range}`,
      accessibleLabel: `${item.name} scale: fixed from ${scale.min} to ${scale.max}`,
      title: `Fixed scale ${scale.min} to ${scale.max}`,
    };
  }
  return { label: 'AUTO', accessibleLabel: `${item.name} scale: auto`, title: 'Autoscale to the visible signal' };
}

export function TrackLibrary({ controller, actions, groupColors, compact = false, onInspect, onInspectModel }: { controller: TrackManagerController; actions: TrackManagerActions; groupColors?: ReadonlyMap<string, string>; compact?: boolean; onInspect?: () => void; onInspectModel?: (instanceId: string) => void }) {
  const { sortedItems, query, setQuery, visibilityFilter, setVisibilityFilter, originFilter, setOriginFilter, collections, collectionIsExpanded, toggleCollection, selectableItems, selectableIdSet, selectedItems, selectedIdSet, setSelectedIds, allResultsSelected, selectResultsRef, editingId, setEditingId, editedNames, setEditedNames, allIds } = controller;
  const { onMove, onMoveGroup, onToggle, onBulkToggle, onRename, onDelete, onBulkDelete } = actions;
  const moveItem = (item: TrackManagerViewItem, delta: number) => {
    const members = itemMembers(item);
    if (members.length > 1 && onMoveGroup) onMoveGroup(members, delta);
    else onMove(members[0], delta);
  };

  return <>
      <div className="track-manager-filters">
        <label className="track-manager-search">
          <span className="sr-only">Find tracks</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find tracks or outputs" />
        </label>
        <div className="track-manager-filter-row" aria-label="Track visibility filter">
          {(['shown', 'hidden', 'all'] as const).map((filter) => (
            <button key={filter} type="button" aria-pressed={visibilityFilter === filter} onClick={() => setVisibilityFilter(filter)}>
              {filter[0].toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>
        <div className="track-manager-filter-row sources" aria-label="Track source filter">
          <button type="button" aria-pressed={originFilter === 'all'} onClick={() => setOriginFilter('all')}>All sources</button>
          <button type="button" aria-pressed={originFilter === 'data'} onClick={() => setOriginFilter('data')}>Data</button>
          <button type="button" aria-pressed={originFilter === 'model'} onClick={() => setOriginFilter('model')}>Models</button>
        </div>
      </div>

      <div className={`track-manager-selectionbar${selectedItems.length > 0 ? ' active' : ''}`}>
        <label className="track-manager-select-results">
          <input
            ref={selectResultsRef}
            type="checkbox"
            checked={allResultsSelected}
            disabled={selectableItems.length === 0}
            onChange={(event) => {
              setSelectedIds((previous) => {
                const next = new Set(previous.filter((id) => !selectableIdSet.has(id)));
                if (event.target.checked) selectableItems.forEach((item) => next.add(item.id));
                return Array.from(next);
              });
            }}
            aria-label="Select results"
          />
          <span>{selectedItems.length > 0 ? `${selectedItems.length} selected` : `${selectableItems.length} results`}</span>
        </label>
      </div>
      <div className="track-manager-panel" aria-label="Track manager rows">
        {collections.length === 0 ? (
          <div className="track-manager-empty">
            <strong>No matching tracks</strong>
            <span>Change the filters or search for another output.</span>
          </div>
        ) : collections.map((collection) => {
          const expanded = collectionIsExpanded(collection);
          const allCollectionItems = sortedItems.filter((item) => item.collectionId === collection.id);
          const enabledOutputs = allCollectionItems.reduce((sum, item) => sum + item.enabledCount, 0);
          const totalOutputs = allCollectionItems.reduce((sum, item) => sum + item.totalCount, 0);
          // A model collection wears its model's group colour; a collection of a
          // model with several output collections nests its rows under them,
          // each in its shade, the way the track list does.
          const instanceId = collection.items.find((item) => item.instanceId)?.instanceId;
          const groupColor = instanceId ? groupColors?.get(instanceId) : undefined;
          const collectionStyle = groupColor ? ({ '--group-color': groupColor } as CSSProperties) : undefined;
          return (
            <section className={`track-manager-collection ${collection.origin}`} key={collection.id} data-origin={collection.origin} style={collectionStyle}>
              <div className="track-manager-collection__header">
              <button className="track-manager-collection__summary" type="button" aria-expanded={expanded} onClick={() => toggleCollection(collection.id, collection.origin)}>
                <span className="track-manager-collection__rail" aria-hidden="true" />
                <span className="track-manager-collection__identity">
                  <strong>{collection.name}</strong>
                  <span>{compact ? `${enabledOutputs} of ${totalOutputs} ${instanceId ? 'outputs' : 'tracks'} shown` : `${collection.items.length} matching tracks · ${enabledOutputs}/${totalOutputs} outputs shown`}</span>
                </span>
                <span className="track-manager-collection__chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>

              {compact && instanceId && onInspectModel ? <button type="button" className="wb-model-settings" aria-label={`Model settings for ${collection.name}`} title="Model settings" onClick={() => onInspectModel(instanceId)}><svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 6h14M3 14h14" /><circle cx="7" cy="6" r="2" fill="var(--surface)" /><circle cx="13" cy="14" r="2" fill="var(--surface)" /></svg></button> : null}
              </div>
              {expanded ? (
                <ul>
                  {collection.items.map((item, itemIndex) => {
                    const status = scaleStatus(item);
                    const members = itemMembers(item);
                    const isEditing = editingId === item.id;
                    const globalIndex = allIds.indexOf(item.id);
                    const visibilityLabel = item.visibility === 'shown'
                      ? 'Shown'
                      : item.visibility === 'hidden'
                        ? 'Hidden'
                        : `${item.enabledCount}/${item.totalCount} shown`;
                    const shade = item.subgroupId !== undefined && groupColor
                      ? subgroupColor(groupColor, item.subgroupIndex ?? 0, item.subgroupCount ?? 1)
                      : undefined;
                    const previous = collection.items[itemIndex - 1];
                    const startsSubgroup = item.subgroupId !== undefined && previous?.subgroupId !== item.subgroupId;
                    const rowStyle = shade ? ({ '--subgroup-color': shade } as CSSProperties) : undefined;
                    return (
                      <li
                        className={`track-manager-row${selectedIdSet.has(item.id) ? ' selected' : ''}`}
                        key={item.id}
                        data-subgroup-id={item.subgroupId}
                        style={rowStyle}
                      >
                        {startsSubgroup ? (
                          <div className="track-manager-subgroup" role="heading" aria-level={4}>
                            <span className="track-manager-subgroup__name">{item.subgroupLabel}</span>
                          </div>
                        ) : null}
                        <input
                          className="track-manager-select"
                          type="checkbox"
                          checked={selectedIdSet.has(item.id)}
                          onChange={(event) => setSelectedIds((previous) => event.target.checked
                            ? Array.from(new Set([...previous, item.id]))
                            : previous.filter((id) => id !== item.id))}
                          aria-label={`Select ${item.name}`}
                        />
                        <span
                          className="track-manager-color"
                          style={{ background: item.members.length > 1 ? stackedSwatch(item.members.map((member) => member.color)) : item.color }}
                          aria-hidden="true"
                        />
                        <div className="track-manager-identity">
                          {isEditing ? (
                            <input
                              className="track-manager-name"
                              aria-label={`Name for ${item.name}`}
                              autoFocus
                              value={editedNames[item.id] ?? item.name}
                              onChange={(event) => setEditedNames((previous) => ({ ...previous, [item.id]: event.target.value }))}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  onRename(members[0], editedNames[item.id] ?? item.name);
                                  setEditingId(null);
                                }
                                if (event.key === 'Escape') setEditingId(null);
                              }}
                            />
                          ) : compact ? <button type="button" className="track-manager-name-text wb-track-select" aria-pressed={selectedIdSet.has(item.id)} onClick={() => { setSelectedIds([item.id]); onInspect?.(); }}>{item.name}</button> : <strong className="track-manager-name-text">{item.name}</strong>}
                          {(!compact || item.origin !== 'model') && <span className="track-manager-provenance">
                            {item.sourceLabel}
                            {item.totalCount > 1 ? ` · ${item.enabledCount}/${item.totalCount} outputs` : ''}
                          </span>}
                          {item.members.length > 1 ? (
                            <span className="track-manager-members" aria-label={`${item.name} members`}>
                              {item.members.map((member) => (
                                <span key={member.id} style={{ color: member.color }}>● {member.name}</span>
                              ))}
                            </span>
                          ) : null}
                          <span className="track-manager-badges">
                            {status && !compact ? <span className={`track-manager-scale-status ${item.yScale?.mode ?? 'auto'}`} aria-label={status.accessibleLabel} title={status.title}>{status.label}</span> : null}
                            {item.kind === 'signal' && item.signalDisplay === 'sequence' ? <span className="track-manager-display-status">{compact ? 'DNA height' : 'DNA'}</span> : null}
                          </span>
                        </div>
                        <div className="track-manager-actions">
                          <button
                            className={`track-manager-visibility ${item.visibility}`}
                            type="button"
                            aria-pressed={item.visibility !== 'hidden'}
                            aria-label={`${item.visibility === 'shown' ? 'Hide' : 'Show'} ${item.name}`}
                            onClick={() => members.length === 1 ? onToggle(members[0]) : onBulkToggle(members, item.visibility !== 'shown')}
                          >{visibilityLabel}</button>
                          {!compact ? <>
                          <button type="button" aria-label={`Move up ${item.name}`} disabled={globalIndex <= 0} onClick={() => moveItem(item, -1)}>↑</button>
                          <button type="button" aria-label={`Move down ${item.name}`} disabled={globalIndex < 0 || globalIndex >= allIds.length - 1} onClick={() => moveItem(item, 1)}>↓</button>
                          {item.renameable ? (
                            isEditing ? (
                              <>
                                <button type="button" aria-label={`Save ${item.name}`} onClick={() => {
                                  onRename(members[0], editedNames[item.id] ?? item.name);
                                  setEditingId(null);
                                }}>Save</button>
                                <button type="button" aria-label={`Cancel rename ${item.name}`} onClick={() => setEditingId(null)}>Cancel</button>
                              </>
                            ) : <button type="button" aria-label={`Rename ${item.name}`} onClick={() => setEditingId(item.id)}>Edit</button>
                          ) : null}
                          <button type="button" aria-label={`Delete ${item.name}`} onClick={() => members.length === 1 ? onDelete(members[0]) : onBulkDelete(members)}>×</button>
                          </> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
  </>;
}
