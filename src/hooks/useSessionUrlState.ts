import { useCallback, useState } from 'react';

import { decodeSessionState, encodeSessionState } from '../features/session/stateCodec';

type SessionStateRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is SessionStateRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStateFromUrl = <T extends SessionStateRecord>(key: string, initialState: T): T => {
  if (typeof window === 'undefined') {
    return initialState;
  }

  try {
    const encodedState = new URLSearchParams(window.location.search).get(key);
    if (!encodedState) {
      return initialState;
    }

    const decodedState = decodeSessionState(encodedState);
    return isRecord(decodedState) ? (decodedState as T) : initialState;
  } catch {
    return initialState;
  }
};

const writeStateToUrl = (key: string, state: SessionStateRecord): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  params.set(key, encodeSessionState(state));

  const search = params.toString();
  const nextUrl = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;

  window.history.replaceState(window.history.state, '', nextUrl);
};

export function useSessionUrlState<T extends Record<string, unknown>>(
  key: string,
  initialState: T,
): [T, (next: T) => void] {
  const [state, setState] = useState<T>(() => readStateFromUrl(key, initialState));

  const setSessionState = useCallback(
    (next: T) => {
      setState(next);

      try {
        writeStateToUrl(key, next);
      } catch {
        // Ignore URL sync failures while still updating local state.
      }
    },
    [key],
  );

  return [state, setSessionState];
}
