export type SignalDomain = {
  min: number;
  max: number;
};

export type TrackScaleConfig =
  | { mode: 'auto' }
  | { mode: 'linked'; groupId: string }
  | { mode: 'fixed'; min: number; max: number };

/** A manager request; the owner assigns a durable group id for linked tracks. */
export type TrackScaleRequest =
  | { mode: 'auto' }
  | { mode: 'linked' }
  | { mode: 'fixed'; min: number; max: number };

export const DEFAULT_SIGNAL_DOMAIN: SignalDomain = Object.freeze({ min: 0, max: 1 });

function finiteDomain(domain: SignalDomain | null | undefined): SignalDomain | null {
  if (!domain || !Number.isFinite(domain.min) || !Number.isFinite(domain.max)) {
    return null;
  }

  return domain.min <= domain.max
    ? { min: domain.min, max: domain.max }
    : { min: domain.max, max: domain.min };
}

function expandCollapsedDomain(domain: SignalDomain): SignalDomain {
  if (domain.min !== domain.max) {
    return domain;
  }

  const padding = Math.max(Math.abs(domain.min) * 0.05, Number.EPSILON * 16, 1e-12);
  return {
    min: domain.min - padding,
    max: domain.max + padding,
  };
}

/**
 * Produces an ordered, finite, non-zero-width domain. Reversed domains are
 * accepted because data readers do not always guarantee endpoint order.
 */
export function normalizeSignalDomain(
  domain: SignalDomain | null | undefined,
  fallback: SignalDomain = DEFAULT_SIGNAL_DOMAIN,
): SignalDomain {
  const normalized = finiteDomain(domain);
  if (normalized) {
    return expandCollapsedDomain(normalized);
  }

  const normalizedFallback = finiteDomain(fallback) ?? DEFAULT_SIGNAL_DOMAIN;
  return expandCollapsedDomain(normalizedFallback);
}

/** Returns the finite union, or null when no usable domain was provided. */
export function unionSignalDomains(
  domains: Iterable<SignalDomain | null | undefined>,
): SignalDomain | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let found = false;

  for (const candidate of domains) {
    const domain = finiteDomain(candidate);
    if (!domain) {
      continue;
    }

    min = Math.min(min, domain.min);
    max = Math.max(max, domain.max);
    found = true;
  }

  return found ? expandCollapsedDomain({ min, max }) : null;
}

export function signalDomainsEqual(
  left: SignalDomain | null | undefined,
  right: SignalDomain | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.min === right.min && left.max === right.max;
}

type LinkedDomainEntry = {
  contributors: Map<string, SignalDomain>;
  domain: SignalDomain | null;
};

export type LinkedSignalDomainRegistry = {
  subscribe(groupId: string, viewportKey: string, listener: () => void): () => void;
  version(groupId: string, viewportKey: string): number;
  register(
    groupId: string,
    viewportKey: string,
    contributorId: string,
    domain: SignalDomain,
  ): () => void;
  remove(groupId: string, viewportKey: string, contributorId: string): void;
  read(groupId: string, viewportKey: string): SignalDomain | null;
};

function registryKey(groupId: string, viewportKey: string): string {
  // JSON encoding avoids collisions when either part contains a delimiter.
  return JSON.stringify([groupId, viewportKey]);
}

/**
 * Creates a tiny external store suitable for useSyncExternalStore. Components
 * subscribe to `version`, then read the cached aggregate domain. Registration
 * is contributor-based so virtualized rows can cleanly enter and leave a view.
 */
export function createLinkedSignalDomainRegistry(): LinkedSignalDomainRegistry {
  const entries = new Map<string, LinkedDomainEntry>();
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();

  const notifyIfChanged = (key: string, previous: SignalDomain | null, next: SignalDomain | null) => {
    if (signalDomainsEqual(previous, next)) {
      return;
    }

    versions.set(key, (versions.get(key) ?? 0) + 1);
    for (const listener of listeners.get(key) ?? []) {
      listener();
    }
  };

  const remove = (groupId: string, viewportKey: string, contributorId: string) => {
    const key = registryKey(groupId, viewportKey);
    const entry = entries.get(key);
    if (!entry || !entry.contributors.has(contributorId)) {
      return;
    }

    const previous = entry.domain;
    entry.contributors.delete(contributorId);
    entry.domain = unionSignalDomains(entry.contributors.values());
    if (entry.contributors.size === 0) {
      entries.delete(key);
    }
    notifyIfChanged(key, previous, entry.domain);
  };

  return {
    subscribe(groupId, viewportKey, listener) {
      const key = registryKey(groupId, viewportKey);
      const keyListeners = listeners.get(key) ?? new Set<() => void>();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);

      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) {
          listeners.delete(key);
        }
      };
    },

    version(groupId, viewportKey) {
      return versions.get(registryKey(groupId, viewportKey)) ?? 0;
    },

    register(groupId, viewportKey, contributorId, domain) {
      const key = registryKey(groupId, viewportKey);
      const entry = entries.get(key) ?? {
        contributors: new Map<string, SignalDomain>(),
        domain: null,
      };
      const previous = entry.domain;
      entry.contributors.set(contributorId, normalizeSignalDomain(domain));
      entry.domain = unionSignalDomains(entry.contributors.values());
      entries.set(key, entry);
      notifyIfChanged(key, previous, entry.domain);

      return () => remove(groupId, viewportKey, contributorId);
    },

    remove,

    read(groupId, viewportKey) {
      return entries.get(registryKey(groupId, viewportKey))?.domain ?? null;
    },
  };
}

export const linkedSignalDomainRegistry = createLinkedSignalDomainRegistry();
