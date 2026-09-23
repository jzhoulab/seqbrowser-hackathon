import type { MutantOverlayData } from './mutagenesis';

/**
 * The base under the pointer on an ISM row, with what the mean of its three
 * mutants predicts, every channel. The ISM row publishes; every prediction
 * series of the same model instance and strand draws its own channel of it --
 * combined, split or user-grouped rows alike. A tiny external store rather
 * than React state so a hover never re-renders the list.
 */
export type MutantOverlay = {
  /** The ISM row that published, so only it clears what it set. */
  ownerTrackId: string;
  instanceId: string;
  chr: string;
  strand: '+' | '-';
  outputName: string;
  data: MutantOverlayData;
};

let current: MutantOverlay | null = null;
const listeners = new Set<() => void>();

export function getMutantOverlay(): MutantOverlay | null {
  return current;
}

export function setMutantOverlay(next: MutantOverlay | null): void {
  if (next === current) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

export function clearMutantOverlay(ownerTrackId: string): void {
  if (current?.ownerTrackId === ownerTrackId) {
    setMutantOverlay(null);
  }
}

export function subscribeMutantOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
