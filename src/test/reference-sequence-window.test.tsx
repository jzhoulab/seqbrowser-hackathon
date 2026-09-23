import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGenomeSequence } from '../data/sequenceDataSource';
import { useReferenceSequenceWindow } from '../hooks/useReferenceSequenceWindow';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  };
}

function sequenceResponse(sequence: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ dna: sequence }),
  } as Response;
}

function requestedSpan(url: string): number {
  const match = url.match(/;start=(\d+);end=(\d+)$/);
  if (!match) {
    throw new Error(`Unexpected sequence URL: ${url}`);
  }
  return Number(match[2]) - Number(match[1]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared reference-sequence windows', () => {
  it('reuses a covering pending window and slices it to the requested coordinates', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const covering = fetchGenomeSequence({
      genome: 'covering-reuse-test',
      chr: 'chr7',
      start: 1_000,
      end: 1_100,
    });
    const nested = fetchGenomeSequence({
      genome: 'covering-reuse-test',
      chr: 'chr7',
      start: 1_020,
      end: 1_080,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.resolve(sequenceResponse('ACGT'.repeat(25)));

    await expect(covering).resolves.toBe('ACGT'.repeat(25));
    await expect(nested).resolves.toBe('ACGT'.repeat(15));
  });

  it('keeps a shared request alive when one hook consumer unmounts', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const args = {
      genome: 'consumer-unmount-test',
      chr: 'chr3',
      chrLength: 50_000,
      start: 20_000,
      end: 20_120,
      minBufferBp: 360,
    };

    const first = renderHook(() => useReferenceSequenceWindow(args));
    const second = renderHook(() => useReferenceSequenceWindow(args));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    response.resolve(sequenceResponse('G'.repeat(requestedSpan(requestUrl))));

    await waitFor(() => {
      expect(second.result.current.loading).toBe(false);
      expect(second.result.current.error).toBeNull();
      expect(second.result.current.start).toBeLessThanOrEqual(args.start);
      expect(second.result.current.end).toBeGreaterThanOrEqual(args.end);
      expect(second.result.current.sequence).toMatch(/^G+$/);
    });
    // The shared request must not carry any CONSUMER's abort signal: the first
    // hook unmounted above and the request stayed alive for the second. The
    // signal that is present belongs to the fetch deadline, and it is not
    // aborted by a consumer going away.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal?.aborted ?? false).toBe(false);

    second.unmount();
  });
});
