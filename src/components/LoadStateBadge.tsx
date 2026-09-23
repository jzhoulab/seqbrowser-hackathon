import { deriveGlobalLoadState } from '../features/ui/loadStates';

type BadgeTrackState = 'loading' | 'ready' | 'empty' | 'failed';

export interface LoadStateBadgeProps {
  trackStates: Array<BadgeTrackState>;
}

function toBadgeText(state: string, hasPartialFailure: boolean): string {
  if (state === 'mixed' && hasPartialFailure) {
    return 'mixed (partial failure)';
  }

  return state;
}

export function LoadStateBadge({ trackStates }: LoadStateBadgeProps) {
  const summary = deriveGlobalLoadState(trackStates);
  const text = toBadgeText(summary.state, summary.hasPartialFailure);

  return <span className="load-state-badge">{text}</span>;
}
