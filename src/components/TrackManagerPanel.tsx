import { useTrackManager } from '../features/tracks/useTrackManager';
import type { TrackManagerPanelProps } from '../features/tracks/managerControls';
import { TrackLibrary } from './TrackLibrary';
import { TrackProperties } from './TrackProperties';

export type { TrackManagerPanelItem } from '../features/tracks/managerControls';

/** Original panel composition, built from the same controls as Workbench. */
export function TrackManagerPanel({ items, groupColors, onClose, ...actions }: TrackManagerPanelProps) {
  const controller = useTrackManager(items);
  const { shownViewCount, shownOutputCount, totalOutputCount } = controller;
  return <section className="track-manager-wrapper" id="track-manager-panel" aria-labelledby="track-manager-title">
      <header className="hf-workspace-panel-header track-manager-header">
        <div>
          <p className="hf-workspace-panel-eyebrow">Viewing stack</p>
          <h2 id="track-manager-title">Tracks</h2>
          <p>{shownViewCount} plotted tracks · {shownOutputCount} of {totalOutputCount} outputs shown</p>
        </div>
        {onClose ? (
          <button className="hf-workspace-panel-close" type="button" onClick={onClose} aria-label="Close Tracks">
            ×
          </button>
        ) : null}
      </header>

    <div className="track-manager-properties"><TrackProperties controller={controller} actions={actions} /></div>
    <TrackLibrary controller={controller} actions={actions} groupColors={groupColors} />
  </section>;
}

export default TrackManagerPanel;
