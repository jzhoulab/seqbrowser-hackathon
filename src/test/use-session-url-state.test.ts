import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeSessionState, encodeSessionState } from '../features/session/stateCodec';
import { useSessionUrlState } from '../hooks/useSessionUrlState';

type SessionStateFixture = {
  assemblyId: string;
  locus: {
    chr: string;
    start: number;
    end: number;
  };
};

describe('useSessionUrlState', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes initial state from ?state= payload', () => {
    const encodedState = encodeSessionState({
      assemblyId: 'hg38',
      locus: { chr: 'chr7', start: 55_019_017, end: 55_211_628 },
    });

    window.history.replaceState(null, '', `/?state=${encodedState}`);

    const initialState: SessionStateFixture = {
      assemblyId: 'mm10',
      locus: { chr: 'chr1', start: 100, end: 200 },
    };

    const { result } = renderHook(() => useSessionUrlState('state', initialState));

    expect(result.current[0]).toEqual({
      assemblyId: 'hg38',
      locus: { chr: 'chr7', start: 55_019_017, end: 55_211_628 },
    });
  });

  it('encodes updates back into URL using history.replaceState', () => {
    const initialState: SessionStateFixture = {
      assemblyId: 'hg38',
      locus: { chr: 'chr7', start: 55_019_017, end: 55_211_628 },
    };
    const nextState: SessionStateFixture = {
      assemblyId: 'hg19',
      locus: { chr: 'chr1', start: 1_000, end: 5_000 },
    };

    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    const { result } = renderHook(() => useSessionUrlState('state', initialState));

    act(() => {
      result.current[1](nextState);
    });

    const encodedState = new URLSearchParams(window.location.search).get('state');

    expect(encodedState).not.toBeNull();
    expect(decodeSessionState(encodedState!)).toEqual(nextState);
    expect(result.current[0]).toEqual(nextState);
    expect(replaceStateSpy).toHaveBeenCalledOnce();
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('falls back to initial state for invalid payload without throwing', () => {
    window.history.replaceState(null, '', '/?state=not-valid***');

    const initialState: SessionStateFixture = {
      assemblyId: 'hg38',
      locus: { chr: 'chr7', start: 100, end: 200 },
    };

    const { result } = renderHook(() => useSessionUrlState('state', initialState));

    expect(result.current[0]).toEqual(initialState);
  });
});
