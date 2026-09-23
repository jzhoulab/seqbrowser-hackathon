import type { CSSProperties } from 'react';

export type ModelRailState = 'ready' | 'computing' | 'missing';

export type ModelRailSegment = {
  key: string;
  state: ModelRailState;
  leftPercent: number;
  widthPercent: number;
};

export type ModelGroupStatus = {
  instanceId: string;
  packId: string;
  name: string;
  assemblyId?: string;
  visibleOutputCount: number;
  availableOutputCount: number;
  state: 'requires-assembly' | 'fit-window' | 'hidden' | 'preparing' | 'computing' | 'ready';
  stateLabel: string;
  segments: readonly ModelRailSegment[];
  currentLeftPercent: number;
  currentWidthPercent: number;
};

export type ModelGroupHeaderProps = {
  group: ModelGroupStatus;
  /** The model's group colour; its rows and subgroups wear shades of it. */
  color: string;
  onFit: (instanceId: string) => void;
  onOpenModels: () => void;
  /** Unmount the model, tracks and all. As easy as adding it was. */
  onRemove?: (instanceId: string) => void;
};

/**
 * The header row of a mounted model in the track list: its name, what is shown,
 * its status, and the way into its outputs. It sits directly above the model's
 * rows, so the list reads as a tree -- the model, its collections, their rows.
 */
export function ModelGroupHeader({ group, color, onFit, onOpenModels, onRemove }: ModelGroupHeaderProps) {
  // A model that has already computed the view has nothing to report. The
  // row keeps only its name and the way into the output picker; the status
  // line and the coverage rail come back the moment there is news --
  // preparing, computing, out of window, wrong reference.
  const settled = group.state === 'ready';
  return (
    <div
      className="hf-model-group"
      role="group"
      aria-label={`${group.name} model tracks`}
      data-model-id={group.packId}
      data-model-instance-id={group.instanceId}
      data-state={group.state}
      data-settled={settled ? 'true' : undefined}
      style={{ '--group-color': color } as CSSProperties}
    >
      <div className="hf-model-group__label">
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onOpenModels}>
          {group.name}
        </button>
        <span>
          {group.visibleOutputCount} shown · {group.availableOutputCount} available ·{' '}
          {group.assemblyId ?? 'active reference'}
        </span>
      </div>
      <div className="hf-model-group__viewport">
        <div className="hf-model-group__statusline">
          {settled ? null : (
            <span className="hf-model-group__status" role="status" aria-live="polite">
              {group.stateLabel}
            </span>
          )}
          {group.state === 'fit-window' || group.state === 'requires-assembly' ? (
            <button
              className="hf-model-group__fit"
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onFit(group.instanceId)}
            >
              {group.state === 'requires-assembly' ? `Switch to ${group.assemblyId}` : 'Fit model window'}
            </button>
          ) : (
            <button
              className="hf-model-group__details"
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenModels}
            >
              Outputs
            </button>
          )}
          {onRemove ? (
            <button
              className="hf-model-group__details hf-model-group__remove"
              type="button"
              aria-label={`Remove ${group.name}`}
              title={`Remove ${group.name} and all of its tracks`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onRemove(group.instanceId)}
            >
              Remove
            </button>
          ) : null}
        </div>
        {settled ? null : (
          <div className="hf-compute-rail" aria-hidden="true">
            {group.segments.map((segment) => (
              <span
                key={segment.key}
                className="hf-compute-rail__segment"
                data-state={segment.state}
                style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }}
              />
            ))}
            <span
              className="hf-compute-rail__current"
              style={{ left: `${group.currentLeftPercent}%`, width: `${group.currentWidthPercent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default ModelGroupHeader;
