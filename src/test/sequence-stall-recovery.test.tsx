import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferenceSequenceWindow } from '../hooks/useReferenceSequenceWindow';

// One stalled UCSC response used to pin "loading…" for the rest of the session:
// the shared cache held the dead promise and every later window joined it. With
// a deadline the stall errors, the cache evicts, and the next request is fresh.

function Probe(props: { start: number; end: number }) {
  const w = useReferenceSequenceWindow({ genome: 'hg38', chr: 'chr7', chrLength: 159_345_973, ...props });
  return <div data-testid="state">{w.loading ? 'loading' : w.error ? `error:${w.error}` : `ok:${w.sequence.length}`}</div>;
}

let stalled = true;
beforeEach(() => {
  vi.useFakeTimers();
  stalled = true;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (stalled) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    const m = /start=(\d+);end=(\d+)/.exec(url)!;
    const len = Number(m[2]) - Number(m[1]);
    return Promise.resolve(new Response(JSON.stringify({ dna: 'A'.repeat(len) }), { status: 200 }));
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sequence window recovers from a stalled host', () => {
  it('a stall becomes an error, and a later request with the host back succeeds', async () => {
    const { rerender } = render(<Probe start={117_513_500} end={117_513_900} />);
    expect(screen.getByTestId('state').textContent).toBe('loading');

    // Past the headers deadline: the stall errors instead of hanging.
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(screen.getByTestId('state').textContent).toMatch(/^error:.*timed out/);

    // Host recovers; the user pans to a new window. Must NOT join the dead promise.
    stalled = false;
    rerender(<Probe start={117_520_000} end={117_520_400} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByTestId('state').textContent).toMatch(/^ok:\d+/);
  });
});
