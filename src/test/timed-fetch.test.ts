import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchTimeoutError, timedFetch } from '../data/timedFetch';

// A UCSC host under load accepts the connection and then stalls without closing
// it. A bare fetch never settles, and because the sequence cache and the bigWig
// readers share the in-flight promise, one stall pinned "loading…" on screen for
// the rest of the session. These pin that a stall becomes an error instead.

/** A fetch that stalls before headers. Like the real one, it does reject on abort. */
function neverSettling(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

function stalledBody(): Response {
  return new Response(
    new ReadableStream({ start() { /* never enqueues, never closes */ } }),
    { status: 200 },
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('timedFetch', () => {
  it('rejects when headers never arrive', async () => {
    vi.stubGlobal('fetch', vi.fn(neverSettling));
    const pending = timedFetch('https://example.test/seq', { headersTimeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it('names the phase and the url in the error, so a stall is diagnosable', async () => {
    vi.stubGlobal('fetch', vi.fn(neverSettling));
    const pending = timedFetch('https://example.test/seq', { headersTimeoutMs: 500 });
    const assertion = expect(pending).rejects.toThrow(/headers.*example\.test\/seq/);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it('rejects when headers arrive but the body never finishes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      // Honour the abort the way a real fetch does: the body read rejects.
      const response = stalledBody();
      const signal = init?.signal;
      const originalJson = response.json.bind(response);
      response.json = () =>
        new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          void originalJson().then(resolve, reject);
        });
      return response;
    }));
    const response = await timedFetch('https://example.test/seq', { headersTimeoutMs: 1_000, bodyTimeoutMs: 2_000 });
    const body = response.json();
    const assertion = expect(body).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
  });

  it('passes a fast response through untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ dna: 'ACGT' }), { status: 200 })));
    const response = await timedFetch('https://example.test/seq');
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ dna: 'ACGT' });
  });

  it("reports the caller's own abort as an abort, not a timeout", async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    ));
    const controller = new AbortController();
    const pending = timedFetch('https://example.test/seq', { signal: controller.signal, headersTimeoutMs: 10_000 });
    const assertion = expect(pending).rejects.toSatisfy((error: unknown) => !(error instanceof FetchTimeoutError));
    controller.abort();
    await assertion;
  });
});
