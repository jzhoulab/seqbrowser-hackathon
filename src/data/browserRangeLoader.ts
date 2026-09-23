import { timedFetch } from './timedFetch';
import { isHostFailure, rememberUcscHost, ucscUrlCandidates } from './ucscMirrors';

/**
 * How long the preferred UCSC host gets before the next mirror is asked as
 * well. UCSC answers a range read in well under a second. An outage shows up
 * as a connection that neither completes nor refuses, and waiting out the 15 s
 * deadline on it held every remote track, and every model that reads the MANE
 * transcripts for its padding, for 15 s on each page load (measured on
 * 2026-09-11, when hgdownload stalled while hgdownload2 answered in 0.3 s).
 * Past this delay the mirror races the primary and the first good answer wins.
 */
export const UCSC_HEDGE_DELAY_MS = 1_200;

export class BrowserRangeLoader {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async load(start: number, size?: number): Promise<ArrayBuffer> {
    const end = size ? start + size - 1 : undefined;
    const headers = new Headers();
    headers.set('Range', `bytes=${start}-${end ?? ''}`);
    const range = `${start}-${end ?? ''}`;

    const candidates = ucscUrlCandidates(this.url);
    if (candidates.length === 1) {
      // A range read is a few kilobytes; a stalled one must not pin a track's
      // "Loading buffer in background…" for the rest of the session.
      const response = await timedFetch(candidates[0]!, { method: 'GET', headers });
      if (!response.ok) {
        throw fileError(response, candidates[0]!, range);
      }
      return response.arrayBuffer();
    }
    return hedgedRangeRead(candidates, headers, range);
  }
}

function fileError(response: Response, candidate: string, range: string): Error {
  return response.status === 416
    ? new Error(`Out of range ${range} for ${candidate}`)
    : new Error(`Range request failed (${response.status}) for ${candidate}`);
}

/**
 * A UCSC file is served by interchangeable mirrors. Ask them in order of
 * preference -- the next one after `UCSC_HEDGE_DELAY_MS` without an answer, or
 * at once when a host fails -- take the first good answer, and cancel the
 * rest. Only a HOST failure (connection refused, DNS, stall, 5xx) moves on: a
 * 404 or 416 is a fact about the file, every mirror would say the same, and it
 * ends the read.
 */
function hedgedRangeRead(candidates: readonly string[], headers: Headers, range: string): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let launched = 0;
    let failures = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (winner: number | null) => {
      settled = true;
      if (hedgeTimer !== null) {
        clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
      controllers.forEach((controller, index) => {
        if (index !== winner) {
          controller.abort();
        }
      });
    };

    const hostFailed = (error: unknown) => {
      failures += 1;
      if (failures >= candidates.length) {
        settle(null);
        reject(error instanceof Error ? error : new Error(`Range request failed on every mirror for ${candidates[0]}`));
        return;
      }
      launch();
    };

    const launch = () => {
      if (settled || launched >= candidates.length) {
        return;
      }
      const index = launched;
      launched += 1;
      const candidate = candidates[index]!;
      const controller = new AbortController();
      controllers.push(controller);
      if (hedgeTimer !== null) {
        clearTimeout(hedgeTimer);
      }
      hedgeTimer = launched < candidates.length ? setTimeout(launch, UCSC_HEDGE_DELAY_MS) : null;

      timedFetch(candidate, { method: 'GET', headers, signal: controller.signal }).then(
        (response) => {
          if (settled) {
            return;
          }
          if (response.ok) {
            settle(index);
            rememberUcscHost(candidate);
            response.arrayBuffer().then(resolve, reject);
            return;
          }
          if (response.status >= 500) {
            // 5xx is the host's problem; 4xx is the file's.
            hostFailed(fileError(response, candidate, range));
            return;
          }
          settle(null);
          reject(fileError(response, candidate, range));
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          if (isHostFailure(error)) {
            hostFailed(error);
            return;
          }
          settle(null);
          reject(error);
        },
      );
    };

    launch();
  });
}
