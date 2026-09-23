import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRangeLoader, UCSC_HEDGE_DELAY_MS } from '../data/browserRangeLoader';
import { UCSC_HOST_CHANNEL, isHostFailure, resetUcscHostPreference, ucscUrlCandidates } from '../data/ucscMirrors';

// On 2026-09-10 hgdownload.soe.ucsc.edu refused TCP connections for an extended
// stretch while hgdownload2 served the same files in under a second. Every
// remote data track was hardwired to the one host, so its outage took every
// bigWig and bigBed with it. The loader now fails over between UCSC's mirrors.

const GENCODE = 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/gencode/gencodeV50.bb';

beforeEach(() => resetUcscHostPreference());
afterEach(() => vi.unstubAllGlobals());

describe('ucscUrlCandidates', () => {
  it('rewrites a UCSC download URL onto every mirror, primary first', () => {
    const urls = ucscUrlCandidates(GENCODE);
    expect(urls[0]).toBe(GENCODE);
    expect(urls).toContain('https://hgdownload2.soe.ucsc.edu/gbdb/hg38/gencode/gencodeV50.bb');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('leaves a non-UCSC URL alone', () => {
    expect(ucscUrlCandidates('https://example.org/data/x.bw')).toEqual(['https://example.org/data/x.bw']);
  });
});

describe('isHostFailure', () => {
  it('treats network errors and deadlines as the host failing', () => {
    expect(isHostFailure(new TypeError('Failed to fetch'))).toBe(true);
    const timeout = new Error('timed out'); timeout.name = 'FetchTimeoutError';
    expect(isHostFailure(timeout)).toBe(true);
  });
  it('does not treat an ordinary error as a reason to try a mirror', () => {
    expect(isHostFailure(new Error('Out of range'))).toBe(false);
  });
});

describe('BrowserRangeLoader failover', () => {
  it('falls back to a mirror when the primary refuses the connection, then prefers it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url).hostname);
      if (url.includes('hgdownload.soe')) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 });
    }));

    const loader = new BrowserRangeLoader(GENCODE);
    const bytes = await loader.load(0, 4);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(calls[0]).toBe('hgdownload.soe.ucsc.edu');
    expect(calls[1]).toBe('hgdownload2.soe.ucsc.edu');

    // The next read goes straight to the mirror that answered.
    calls.length = 0;
    await loader.load(4, 4);
    expect(calls[0]).toBe('hgdownload2.soe.ucsc.edu');
  });

  it('does not try a mirror for a 404: that is a fact about the file', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url).hostname);
      return new Response('', { status: 404 });
    }));
    await expect(new BrowserRangeLoader(GENCODE).load(0, 4)).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });

  it('does try a mirror for a 5xx: that is the host', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url).hostname);
      if (url.includes('hgdownload.soe')) return new Response('', { status: 503 });
      return new Response(new Uint8Array([9]), { status: 206 });
    }));
    await new BrowserRangeLoader(GENCODE).load(0, 1);
    expect(calls).toEqual(['hgdownload.soe.ucsc.edu', 'hgdownload2.soe.ucsc.edu']);
  });

  it('surfaces the last error when every mirror fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(new BrowserRangeLoader(GENCODE).load(0, 4)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('BrowserRangeLoader hedging', () => {
  it('asks the next mirror once the preferred host stalls, takes the first answer, and cancels the stall', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let primarySignal: AbortSignal | undefined;
      vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        calls.push(new URL(url).hostname);
        if (url.includes('hgdownload.soe')) {
          // A stall: no answer, no refusal, until cancelled.
          primarySignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return Promise.resolve(new Response(new Uint8Array([7]), { status: 206 }));
      }));

      const read = new BrowserRangeLoader(GENCODE).load(0, 1);
      await vi.advanceTimersByTimeAsync(UCSC_HEDGE_DELAY_MS - 1);
      expect(calls).toEqual(['hgdownload.soe.ucsc.edu']);
      await vi.advanceTimersByTimeAsync(1);
      expect(new Uint8Array(await read)).toEqual(new Uint8Array([7]));
      expect(calls).toEqual(['hgdownload.soe.ucsc.edu', 'hgdownload2.soe.ucsc.edu']);
      expect(primarySignal?.aborted).toBe(true);
      // And the mirror is where the next read starts.
      expect(ucscUrlCandidates(GENCODE)[0]).toContain('hgdownload2.soe.ucsc.edu');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ask a mirror while the preferred host answers promptly', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url).hostname);
      return new Response(new Uint8Array([1]), { status: 206 });
    }));
    await new BrowserRangeLoader(GENCODE).load(0, 1);
    expect(calls).toEqual(['hgdownload.soe.ucsc.edu']);
  });
});

describe.runIf(typeof BroadcastChannel !== 'undefined')('the learned host is shared between contexts', () => {
  it('tells the other contexts which host answered', async () => {
    const other = new BroadcastChannel(UCSC_HOST_CHANNEL);
    const heard = new Promise((resolve) => {
      other.onmessage = (event) => resolve(event.data);
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('hgdownload.soe')) throw new TypeError('Failed to fetch');
      return new Response(new Uint8Array([1]), { status: 206 });
    }));
    await new BrowserRangeLoader(GENCODE).load(0, 1);
    expect(await heard).toEqual({ hostIndex: 1 });
    other.close();
  });

  it('learns from another context which host answered', async () => {
    const other = new BroadcastChannel(UCSC_HOST_CHANNEL);
    other.postMessage({ hostIndex: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.close();
    expect(ucscUrlCandidates(GENCODE)[0]).toBe('https://hgdownload2.soe.ucsc.edu/gbdb/hg38/gencode/gencodeV50.bb');
  });
});
