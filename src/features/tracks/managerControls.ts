import type { TrackManagerViewItem } from './managerView';
import type { TrackScaleRequest } from '../../lib/signalScale';
import type { SignalDisplayMode, SignalScaleShape } from '../../types';

export type TrackManagerPanelItem = Pick<TrackManagerViewItem, 'id' | 'name' | 'enabled' | 'order' | 'kind'> &
  Partial<Omit<TrackManagerViewItem, 'id' | 'name' | 'enabled' | 'order' | 'kind'>>;

export type TrackManagerPanelProps = {
  items: TrackManagerPanelItem[];
  /** Each mounted model's group colour, by instance; its collection wears it. */
  groupColors?: ReadonlyMap<string, string>;
  onToggle(id: string): void;
  onMove(id: string, delta: number): void;
  onMoveGroup?(ids: string[], delta: number): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  onBulkToggle(ids: string[], nextEnabled: boolean): void;
  onBulkDelete(ids: string[]): void;
  onBulkScale(ids: string[], request: TrackScaleRequest): void;
  onBulkDisplay?(ids: string[], display: SignalDisplayMode): void;
  onBulkScaleShape?(ids: string[], shape: SignalScaleShape): void;
  /** Draw the selected signal tracks as one combined plot. */
  onGroup?(ids: string[]): void;
  /** Take the selected tracks out of their user-defined combined plots. */
  onUngroup?(ids: string[]): void;
  onClose?: () => void;
};


export type TrackManagerActions = Omit<TrackManagerPanelProps, 'items' | 'groupColors' | 'onClose'>;
