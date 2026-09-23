/**
 * `fetch` that cannot hang.
 *
 * Every remote read in the browser goes to a UCSC host, and under load those
 * hosts accept a connection and then stall without closing it. A bare `fetch`
 * never settles in that case. Because the sequence cache and the bigWig/bigBed
 * readers hold the in-flight promise for every later caller to join, one stalled
 * response was enough to pin "loading…" and "Loading buffer in background…" on
 * screen for the rest of the session -- nothing errored, so nothing retried, and
 * only a reload cleared it.
 *
 * A deadline turns that into an error the caller can show and the cache can
 * evict, after which the next request starts fresh. The limits are generous: a
 * slow answer is still an answer.
 */

/** Time to first byte. UCSC is usually well under a second; 15 s is a stall. */
export const FETCH_HEADERS_TIMEOUT_MS = 15_000;
/** Time to the full body. A 6 kb sequence or a few bigWig blocks is tiny; 45 s is a stall. */
export const FETCH_BODY_TIMEOUT_MS = 45_000;

export class FetchTimeoutError extends Error {
  constructor(url: string, phase: 'headers' | 'body', ms: number) {
    super(`Request timed out after ${Math.round(ms / 1000)}s waiting for ${phase}: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

type TimedFetchInit = RequestInit & {
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
};

/** Like fetch, but rejects if headers or the body take too long to arrive. */
export async function timedFetch(url: string, init: TimedFetchInit = {}): Promise<Response> {
  const { headersTimeoutMs = FETCH_HEADERS_TIMEOUT_MS, bodyTimeoutMs = FETCH_BODY_TIMEOUT_MS, signal, ...rest } = init;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let phase: 'headers' | 'body' = 'headers';
  let timer = setTimeout(() => controller.abort(), headersTimeoutMs);

  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    clearTimeout(timer);
    phase = 'body';
    timer = setTimeout(() => controller.abort(), bodyTimeoutMs);
    return wrapBody(response, () => clearTimeout(timer));
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new FetchTimeoutError(url, phase, phase === 'headers' ? headersTimeoutMs : bodyTimeoutMs);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * The body timer has to clear once the body is consumed, and the consumer is the
 * caller. A Proxy over Response breaks its private internals, so instead wrap
 * the three readers this codebase uses on the instance itself. Anything else on
 * the Response is untouched.
 */
function wrapBody(response: Response, done: () => void): Response {
  // Only readers that exist: test doubles often provide just `json`.
  for (const name of ['json', 'arrayBuffer', 'text'] as const) {
    const reader = response[name];
    if (typeof reader !== 'function') continue;
    const bound = reader.bind(response) as () => Promise<unknown>;
    Object.defineProperty(response, name, {
      value: () => bound().finally(done),
      configurable: true,
      writable: true,
    });
  }
  return response;
}
