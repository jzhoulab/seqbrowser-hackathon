export interface TrackManagerItem {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
}

function normalizeSequence(items: readonly TrackManagerItem[]): TrackManagerItem[] {
  return items.map((track, order) => ({ ...track, order }));
}

export function normalizeTrackOrder(items: readonly TrackManagerItem[]): TrackManagerItem[] {
  return [...items]
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      if (left.track.order === right.track.order) {
        return left.index - right.index;
      }
      return left.track.order - right.track.order;
    })
    .map(({ track }, order) => ({ ...track, order }));
}

export function reorderTrack(
  items: readonly TrackManagerItem[],
  trackId: string,
  targetIndex: number,
): TrackManagerItem[] {
  const normalized = normalizeTrackOrder(items);
  const fromIndex = normalized.findIndex((track) => track.id === trackId);
  if (fromIndex < 0 || normalized.length === 0) {
    return normalized;
  }

  const clampedTarget = Math.max(0, Math.min(normalized.length - 1, targetIndex));
  if (fromIndex === clampedTarget) {
    return normalized;
  }

  const reordered = normalized.slice();
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(clampedTarget, 0, moved);
  return normalizeSequence(reordered);
}

export function toggleTrack(
  items: readonly TrackManagerItem[],
  trackId: string,
  nextEnabled?: boolean,
): TrackManagerItem[] {
  const normalized = normalizeTrackOrder(items);
  return normalizeSequence(
    normalized.map((track) => {
      if (track.id !== trackId) {
        return track;
      }

      return {
        ...track,
        enabled: nextEnabled ?? !track.enabled,
      };
    }),
  );
}

export function renameTrack(
  items: readonly TrackManagerItem[],
  trackId: string,
  nextName: string,
): TrackManagerItem[] {
  const normalized = normalizeTrackOrder(items);
  const trimmed = nextName.trim();

  return normalizeSequence(
    normalized.map((track) => {
      if (track.id !== trackId || trimmed.length === 0) {
        return track;
      }

      return {
        ...track,
        name: trimmed,
      };
    }),
  );
}

export function deleteTrack(items: readonly TrackManagerItem[], trackId: string): TrackManagerItem[] {
  const normalized = normalizeTrackOrder(items);
  const filtered = normalized.filter((track) => track.id !== trackId);
  return normalizeSequence(filtered);
}
