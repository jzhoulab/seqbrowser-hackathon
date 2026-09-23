import type { ReactNode } from 'react';
import type { TrackSpec, SignalScaleShape } from '../types';
import { resolveSignalScaleShape, signalScaleShapesFor } from '../lib/signalScaleShape';
import { plotGroupingAction, type PlotGroupingActionKind } from '../lib/userPlotGroups';
import type { TrackManagerController } from '../features/tracks/useTrackManager';
import { uniqueMembers } from '../features/tracks/useTrackManager';
import type { TrackManagerViewItem } from '../features/tracks/managerView';
import type { TrackManagerActions } from '../features/tracks/managerControls';
import type { TrackScaleConfig } from '../lib/signalScale';

function sameScaleMode(items: readonly TrackManagerViewItem[], mode: TrackScaleConfig['mode']): boolean {
  return items.length > 0 && items.every((item) => !item.scaleMixed && (item.yScale?.mode ?? 'auto') === mode);
}

export function TrackProperties({ controller, actions, workbench = false, arrangement, plot, onPlotGroupingChange }: {
  controller: TrackManagerController; actions: TrackManagerActions; workbench?: boolean; arrangement?: ReactNode;
  plot?: TrackSpec; onPlotGroupingChange?(track: TrackSpec, action: PlotGroupingActionKind): void;
}) {
  const { selectedItems, selectedSignalItems, selectedMemberIds, selectedSignalMemberIds, setSelectedIds, fixedMin, setFixedMin, fixedMax, setFixedMax, showFixedInputs, setShowFixedInputs, parsedFixedMin, parsedFixedMax, fixedScaleIsValid } = controller;
  const { onBulkToggle, onBulkDelete, onGroup, onUngroup, onBulkDisplay, onBulkScale } = actions;
  const grouping = plot ? plotGroupingAction(plot) : null;
  const groupingButtons = <>
    {onGroup && (!workbench || selectedSignalItems.length > 1) ? <button type="button" onClick={() => onGroup(selectedSignalMemberIds)} disabled={selectedSignalItems.length < 2} title="Draw the selected signal tracks as one combined plot with a shared axis">Group</button> : null}
    {onUngroup && selectedItems.some((item) => item.plotKind === 'user') ? <button type="button" onClick={() => onUngroup(uniqueMembers(selectedItems.filter((item) => item.plotKind === 'user')))}>Ungroup</button> : null}
    {grouping && grouping.kind !== 'ungroup' && plot && onPlotGroupingChange ? <button type="button" title={grouping.title} onClick={() => onPlotGroupingChange(plot, grouping.kind)}>{grouping.kind === 'split' ? 'Split outputs' : 'Combine outputs'}</button> : null}

  </>;
  return <>
    {selectedItems.length > 0 ? <div className="track-manager-selection-actions">
      {(!workbench || selectedItems.some((item) => item.visibility !== 'shown')) && <button type="button" onClick={() => onBulkToggle(selectedMemberIds, true)}>Show</button>}
      {(!workbench || selectedItems.some((item) => item.visibility !== 'hidden')) && <button type="button" onClick={() => onBulkToggle(selectedMemberIds, false)}>Hide</button>}
      {!workbench && <><button type="button" onClick={() => onBulkDelete(selectedMemberIds)}>Remove</button>{groupingButtons}</>}
      <button type="button" className="wb-clear-selection" aria-label={workbench ? 'Clear selection' : undefined} onClick={() => setSelectedIds([])}>{workbench ? 'Deselect' : 'Clear'}</button>
    </div> : null}

      {selectedSignalItems.length > 0 ? (
        <fieldset className="track-manager-scale-toolbar" aria-label="Style selected signal tracks">
          <legend>{selectedSignalItems.length} signal {selectedSignalItems.length === 1 ? 'track' : 'tracks'}</legend>
          <div className="track-manager-style-row">
            <span className="track-manager-scale-heading">Display</span>
            <button
              type="button"
              aria-pressed={selectedSignalItems.every((item) => !item.displayMixed && item.signalDisplay !== 'sequence')}
              onClick={() => onBulkDisplay?.(selectedSignalMemberIds, 'signal')}
              disabled={!onBulkDisplay}
            >Signal</button>
            <button
              type="button"
              aria-pressed={selectedSignalItems.every((item) => !item.displayMixed && item.signalDisplay === 'sequence')}
              onClick={() => onBulkDisplay?.(selectedSignalMemberIds, 'sequence')}
              disabled={!onBulkDisplay || selectedSignalItems.some((item) => item.totalCount > 1)}
              title={selectedSignalItems.some((item) => item.totalCount > 1) ? 'Split combined plots into individual outputs to use DNA heights.' : 'Uses signed DNA heights whenever true 1-bp data is available'}
            >DNA height</button>
          </div>
          <div className="track-manager-style-row">
            <span className="track-manager-scale-heading">Y scale</span>
            <button type="button" aria-pressed={sameScaleMode(selectedSignalItems, 'auto')} onClick={() => onBulkScale(selectedSignalMemberIds, { mode: 'auto' })}>Auto each</button>
            {(!workbench || selectedSignalItems.length > 1) && <button type="button" aria-pressed={sameScaleMode(selectedSignalItems, 'linked')} onClick={() => onBulkScale(selectedSignalMemberIds, { mode: 'linked' })} disabled={selectedSignalItems.length < 2}>Shared scale</button>}
            <button type="button" aria-pressed={sameScaleMode(selectedSignalItems, 'fixed')} aria-expanded={showFixedInputs} onClick={() => setShowFixedInputs((shown) => !shown)}>Fixed limits</button>
          </div>
          {plot?.kind === 'signal' && actions.onBulkScaleShape ? <label className="track-manager-style-row wb-scale-transform">
            <span className="track-manager-scale-heading">Transform</span>
            <select aria-label="Scale transform" value={resolveSignalScaleShape(plot)} onChange={(event) => actions.onBulkScaleShape?.(selectedSignalMemberIds, event.target.value as SignalScaleShape)}>
              {signalScaleShapesFor(plot).map((shape) => <option key={shape} value={shape}>{{ linear: 'Linear', power: 'Power', log: 'Log', 'complement-log': '−log(1−p)' }[shape]}</option>)}
            </select>
          </label> : null}
          {showFixedInputs ? (
            <form className="track-manager-fixed-scale" onSubmit={(event) => {
              event.preventDefault();
              if (!fixedScaleIsValid) return;
              onBulkScale(selectedSignalMemberIds, { mode: 'fixed', min: parsedFixedMin, max: parsedFixedMax });
            }}>
              <label>Min<input aria-label="Fixed scale minimum" aria-invalid={!fixedScaleIsValid} type="number" step="any" value={fixedMin} onChange={(event) => setFixedMin(event.target.value)} /></label>
              <label>Max<input aria-label="Fixed scale maximum" aria-invalid={!fixedScaleIsValid} type="number" step="any" value={fixedMax} onChange={(event) => setFixedMax(event.target.value)} /></label>
              <button type="submit" disabled={!fixedScaleIsValid}>Apply limits</button>
              {!fixedScaleIsValid ? <span className="track-manager-scale-error" role="alert">Minimum must be less than maximum.</span> : null}
            </form>
          ) : null}
        </fieldset>
      ) : null}

    {workbench && selectedItems.length > 0 ? <details className="wb-arrangement">
      <summary>Arrange tracks</summary>
      <div className="wb-arrangement-controls">{arrangement}<div className="track-manager-selection-actions">{groupingButtons}<button type="button" className="wb-remove-track" onClick={() => onBulkDelete(selectedMemberIds)}>Remove</button></div></div>
    </details> : null}
  </>;
}
