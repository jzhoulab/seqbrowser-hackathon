import { useCallback, useEffect } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import { Virtuoso, type ListRange } from 'react-virtuoso';
import { trackRedrawScheduler } from '../lib/trackRedrawScheduler';
import { trackRangeForRows, type TrackListRow } from '../features/tracks/listRows';
import { SEQUENCE_SECTION_COLORS } from '../lib/groupColors';
import { ModelGroupHeader, type ModelGroupStatus } from './ModelStatusRail';
import { TrackRowCanvas } from './TrackRowCanvas';
import { SequenceStrip } from './SequenceStrip';
import type {
  DataWindowSpec,
  SequenceEdit,
  SignalDisplayMode,
  SignalScaleShape,
  TrackSpec,
  ViewportState,
} from '../types';

type TrackListProps = {
  /** Tracks and the group headers derived from them (see listRows.ts). */
  rows: TrackListRow[];
  selectedTrackIds?: ReadonlySet<string>;
  onSelectTrack?: (track: TrackSpec) => void;
  /** Status of each mounted model, drawn in its header. */
  modelStatuses: ReadonlyMap<string, ModelGroupStatus>;
  onFitModel: (instanceId: string) => void;
  onOpenModels: () => void;
  /** Unmount a model: every track of the instance goes. */
  onRemoveModel?: (instanceId: string) => void;
  /** Stop mirroring one output onto the edited sequence. */
  onHideOnEdited?: (track: TrackSpec) => void;
  viewport: ViewportState;
  windowSpec: DataWindowSpec;
  /** The range of TRACKS on screen (header rows are not counted). */
  onVisibleRangeChange: (range: ListRange) => void;
  genome: string;
  onSignalDisplayChange?: (track: TrackSpec, display: SignalDisplayMode) => void;
  onSignalScaleShapeChange?: (track: TrackSpec, shape: SignalScaleShape) => void;
  /** Split a combined plot into rows, recombine it, or dissolve a user group. */
  onPlotGroupingChange?: (track: TrackSpec, action: 'split' | 'combine' | 'ungroup') => void;
  /** The reader dragged a row's edge or grew it to fit. */
  onHeightChange?: (track: TrackSpec, heightPx: number) => void;
  /** A draft row just spawned by a reference edit: it takes focus and the caret. */
  sequenceReversed?: boolean;
  /** Insertions from every row, so all rows share one column set. */
  columnEdits?: readonly SequenceEdit[];
  // Exposes the virtual list's scroll element so the app can drive vertical track
  // scrolling from Shift+wheel (plain wheel is reserved for zoom).
  scrollerRef?: MutableRefObject<HTMLElement | null>;
};

export function TrackList({
  rows,
  selectedTrackIds,
  onSelectTrack,
  modelStatuses,
  onFitModel,
  onOpenModels,
  onRemoveModel,
  onHideOnEdited,
  viewport,
  windowSpec,
  onVisibleRangeChange,
  genome,
  onSignalDisplayChange,
  onSignalScaleShapeChange,
  onPlotGroupingChange,
  onHeightChange,
  sequenceReversed,
  columnEdits,
  scrollerRef,
}: TrackListProps) {
  useEffect(() => {
    trackRedrawScheduler.requestAll();
  }, [viewport.bpPerPx, viewport.centerBp, viewport.chr, viewport.widthPx]);

  // Virtuoso re-emits the current range to a NEW rangeChanged handler. An inline
  // arrow would be new on every render and set the visible range each time, a
  // loop; this one changes only when the rows do, when a re-emit is wanted
  // anyway because the track indices may have shifted.
  const handleRangeChanged = useCallback(
    (range: ListRange) => onVisibleRangeChange(trackRangeForRows(rows, range)),
    [onVisibleRangeChange, rows],
  );

  return (
    <Virtuoso
      className="track-virtuoso"
      totalCount={rows.length}
      overscan={520}
      scrollerRef={(element) => {
        if (scrollerRef) {
          scrollerRef.current = element as HTMLElement | null;
        }
      }}
      computeItemKey={(index: number) => rows[index]?.id ?? `row-${index}`}
      rangeChanged={handleRangeChanged}
      itemContent={(index) => {
        const row = rows[index];
        if (!row) {
          return null;
        }
        if (row.kind === 'model-header') {
          const status = modelStatuses.get(row.instanceId);
          return status ? (
            <ModelGroupHeader group={status} color={row.groupColor} onFit={onFitModel} onOpenModels={onOpenModels} onRemove={onRemoveModel} />
          ) : (
            <div className="hf-model-group hf-model-group--placeholder" aria-hidden="true" />
          );
        }
        if (row.kind === 'subgroup-header') {
          return (
            <div
              className="hf-subgroup-header"
              role="heading"
              aria-level={3}
              data-model-instance-id={row.instanceId}
              data-subgroup-id={row.subgroupId}
              style={{ '--group-color': row.groupColor, '--subgroup-color': row.subgroupColor } as CSSProperties}
            >
              <div className="hf-subgroup-header__label">
                <span className="hf-subgroup-header__name">{row.label}</span>
                <span className="hf-subgroup-header__count">
                  {row.count} {row.count === 1 ? 'row' : 'rows'}
                </span>
              </div>
              <div className="hf-subgroup-header__viewport" aria-hidden="true" />
            </div>
          );
        }
        const track = row.track;
        if (track.source.type === 'sequence-variant') {
          // The reference sequence, shown beneath the edited row once edits
          // exist. Read-only: the row you edit is the pinned one above the list.
          return (
            <div
              className="sequence-variant-track sequence-reference-track"
              data-section="reference"
              style={{ minHeight: `${track.height}px`, '--section-color': SEQUENCE_SECTION_COLORS.reference } as CSSProperties}
            >
              <SequenceStrip
                viewport={viewport}
                genome={genome}
                title={track.name}
                ariaLabel="Reference sequence"
                embedded
                edits={[]}
                reversed={sequenceReversed}
                columnEdits={columnEdits}
              />
            </div>
          );
        }
        return (
          <TrackRowCanvas
            track={track}
            selected={selectedTrackIds?.has(track.id)}
            onSelect={row.grouping?.section === 'edited' ? undefined : onSelectTrack}
            grouping={row.grouping}
            viewport={viewport}
            windowSpec={windowSpec}
            genome={genome}
            onSignalDisplayChange={onSignalDisplayChange}
            onSignalScaleShapeChange={onSignalScaleShapeChange}
            onPlotGroupingChange={onPlotGroupingChange}
            onHideOnEdited={onHideOnEdited}
            onHeightChange={onHeightChange}
            columnEdits={columnEdits}
            reversed={sequenceReversed}
          />
        );
      }}
    />
  );
}
