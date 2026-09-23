/**
 * UCSC serves its download tree from interchangeable hosts. `hgdownload` (which
 * resolves to hgdownload1) and `hgdownload2` carry the same files at the same
 * paths, with the same CORS headers for range reads. Either host goes down on
 * its own from time to time; on 2026-09-10 hgdownload1 refused TCP connections
 * for an extended stretch while hgdownload2 answered in under a second.
 *
 * Every remote data track was hardwired to one host, so one host's outage took
 * every bigWig and bigBed with it. A URL on any of these hosts can be rewritten
 * to any other; the loader asks them in order of preference, racing the next
 * one once the first is slow (see BrowserRangeLoader), remembers which one
 * answered, and tells every other context, so a page pays for a failover once
 * and briefly.
 */

const UCSC_DOWNLOAD_HOSTS = [
  'hgdownload.soe.ucsc.edu',
  'hgdownload2.soe.ucsc.edu',
  'hgdownload1.soe.ucsc.edu',
] as const;

const HOST_SET = new Set<string>(UCSC_DOWNLOAD_HOSTS);

/** Index into UCSC_DOWNLOAD_HOSTS that last answered, shared by every loader. */
let preferredHostIndex = 0;

/**
 * The main thread and each model worker have their own copy of this module,
 * so each learned the working host on its own and each paid for the failover.
 * A broadcast shares what any one of them learns with the rest.
 */
export const UCSC_HOST_CHANNEL = 'seqbrowser:ucsc-download-host';
let hostChannel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    hostChannel = new BroadcastChannel(UCSC_HOST_CHANNEL);
    hostChannel.onmessage = (event: MessageEvent) => {
      const index = (event.data as { hostIndex?: unknown } | null)?.hostIndex;
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < UCSC_DOWNLOAD_HOSTS.length) {
        preferredHostIndex = index;
      }
    };
    // Node (the unit tests) keeps a process alive on an open channel; browsers have no such notion.
    (hostChannel as unknown as { unref?: () => void }).unref?.();
  }
} catch {
  hostChannel = null;
}

export function isUcscDownloadUrl(url: string): boolean {
  try {
    return HOST_SET.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The same URL on each UCSC download host, preferred host first, then the rest
 * in fixed order. Non-UCSC URLs have exactly one candidate: themselves.
 */
export function ucscUrlCandidates(url: string): string[] {
  if (!isUcscDownloadUrl(url)) {
    return [url];
  }
  const parsed = new URL(url);
  const ordered = [
    UCSC_DOWNLOAD_HOSTS[preferredHostIndex],
    ...UCSC_DOWNLOAD_HOSTS.filter((_, index) => index !== preferredHostIndex),
  ];
  return ordered.map((host) => {
    const candidate = new URL(parsed);
    candidate.hostname = host;
    return candidate.toString();
  });
}

/** Remember the host that answered, so the next request starts there. */
export function rememberUcscHost(url: string): void {
  try {
    const index = UCSC_DOWNLOAD_HOSTS.indexOf(new URL(url).hostname as (typeof UCSC_DOWNLOAD_HOSTS)[number]);
    if (index >= 0 && index !== preferredHostIndex) {
      preferredHostIndex = index;
      hostChannel?.postMessage({ hostIndex: index });
    }
  } catch {
    // Not a URL we route; nothing to remember.
  }
}

/** Test seam. */
export function resetUcscHostPreference(): void {
  preferredHostIndex = 0;
}

/**
 * Whether a failure is the HOST's, not the file's. Only these justify trying a
 * mirror: a 404 or 416 says the same about every mirror, and would just cost a
 * second round trip to learn it again.
 */
export function isHostFailure(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'FetchTimeoutError') return true;
    // `fetch` rejects with a TypeError on network-level failures (refused,
    // reset, DNS, CORS-blocked). Anything the server actually answered is not.
    if (error.name === 'TypeError') return true;
  }
  return false;
}
