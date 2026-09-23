import type { ComputationalPackManifest, ComputationalSubtrackSpec } from '../types';

export type ComputationalOutputSet = {
  /** Stable raw-output identity used by exact inference cache keys. */
  key: string;
  /** Subtracks whose raw output/channel series must be extracted. */
  subtracks: readonly ComputationalSubtrackSpec[];
  /** Unique ONNX output names to pass to `session.run`. */
  outputNames: readonly string[];
  /** Raw output/channel identities available from this set. */
  seriesKeys: ReadonlySet<string>;
};

export function computationalSeriesKey(subtrack: ComputationalSubtrackSpec): string {
  // A mutagenesis row mutates an output rather than reading it; it must not share
  // an identity with that output's plain series, or a cached run of one would be
  // served as the other. The parameters are part of the identity too.
  if (subtrack.mutagenesis) {
    return JSON.stringify([subtrack.outputName, subtrack.channelIndex ?? 0, 'ism', subtrack.mutagenesis.contextBp]);
  }
  return JSON.stringify([subtrack.outputName, subtrack.channelIndex ?? 0]);
}

function buildComputationalOutputSet(
  subtracks: readonly ComputationalSubtrackSpec[],
): ComputationalOutputSet {
  const uniqueSubtracks = new Map<string, ComputationalSubtrackSpec>();
  const outputNames = new Set<string>();

  for (const subtrack of subtracks) {
    const seriesKey = computationalSeriesKey(subtrack);
    if (!uniqueSubtracks.has(seriesKey)) {
      uniqueSubtracks.set(seriesKey, subtrack);
    }
    outputNames.add(subtrack.outputName);
  }

  const seriesKeys = new Set(uniqueSubtracks.keys());
  const key = JSON.stringify(Array.from(seriesKeys).sort());
  return {
    key,
    subtracks: Array.from(uniqueSubtracks.values()),
    outputNames: Array.from(outputNames),
    seriesKeys,
  };
}

/**
 * Grouped packs infer one output collection at a time. A subtrack without a
 * group keeps the original pack-wide behavior for backwards compatibility.
 */
export function resolveComputationalOutputSet(
  pack: ComputationalPackManifest,
  requestedSubtrack: ComputationalSubtrackSpec,
): ComputationalOutputSet {
  return resolveComputationalOutputSetForSubtracks(pack, [requestedSubtrack]);
}

/**
 * Resolve the union of every inference collection represented in one plot.
 * This allows, for example, primary- and opposite-strand collections to share a
 * canvas while retaining a stable raw-output cache identity.
 */
export function resolveComputationalOutputSetForSubtracks(
  pack: ComputationalPackManifest,
  requestedSubtracks: readonly ComputationalSubtrackSpec[],
): ComputationalOutputSet {
  if (requestedSubtracks.length === 0) {
    throw new Error(`Computational model "${pack.name}" requires at least one requested output.`);
  }

  const selectedSubtracks: ComputationalSubtrackSpec[] = [];
  const selectedGroupIds = new Set<string>();
  let includesLegacyPackWideOutput = false;

  for (const requestedSubtrack of requestedSubtracks) {
    const groupId = requestedSubtrack.groupId;
    if (groupId === undefined) {
      includesLegacyPackWideOutput = true;
      break;
    }
    if (selectedGroupIds.has(groupId)) {
      continue;
    }
    selectedGroupIds.add(groupId);
    const groupSubtracks = pack.subtracks.filter((subtrack) => subtrack.groupId === groupId);
    if (groupSubtracks.length === 0) {
      throw new Error(
        `Computational model "${pack.name}" does not define output group "${groupId}".`,
      );
    }
    selectedSubtracks.push(...groupSubtracks);
  }

  if (includesLegacyPackWideOutput) {
    selectedSubtracks.splice(0, selectedSubtracks.length, ...pack.subtracks);
  }

  if (selectedSubtracks.length === 0) {
    throw new Error(`Computational model "${pack.name}" does not define requested outputs.`);
  }

  const outputSet = buildComputationalOutputSet(selectedSubtracks);
  for (const requestedSubtrack of requestedSubtracks) {
    if (!outputSet.seriesKeys.has(computationalSeriesKey(requestedSubtrack))) {
      throw new Error(
        `Computational model "${pack.name}" does not define output "${requestedSubtrack.outputName}" ` +
        `in group "${requestedSubtrack.groupId}".`,
      );
    }
  }
  return outputSet;
}

/** True when a cached/in-flight raw run contains every required output/channel. */
export function computationalOutputSetCovers(
  availableSeriesKeys: ReadonlySet<string>,
  requiredSeriesKeys: ReadonlySet<string>,
): boolean {
  for (const seriesKey of requiredSeriesKeys) {
    if (!availableSeriesKeys.has(seriesKey)) {
      return false;
    }
  }
  return true;
}

/**
 * Warm only groups represented by default-visible subtracks. Resolving each
 * seed expands it to its whole group, while legacy ungrouped seeds expand to
 * the whole pack. If every output starts hidden, warming the first group still
 * calibrates the model without paying for every optional collection.
 */
export function resolveComputationalWarmupOutputSet(
  pack: ComputationalPackManifest,
): ComputationalOutputSet {
  const defaultVisibleSeeds = pack.subtracks.filter(
    (subtrack) => subtrack.defaultVisible !== false,
  );
  const seeds = defaultVisibleSeeds.length > 0
    ? defaultVisibleSeeds
    : pack.subtracks.slice(0, 1);
  const warmupSubtracks = new Map<string, ComputationalSubtrackSpec>();

  for (const seed of seeds) {
    const outputSet = resolveComputationalOutputSet(pack, seed);
    for (const subtrack of outputSet.subtracks) {
      const seriesKey = computationalSeriesKey(subtrack);
      if (!warmupSubtracks.has(seriesKey)) {
        warmupSubtracks.set(seriesKey, subtrack);
      }
    }
  }

  return buildComputationalOutputSet(Array.from(warmupSubtracks.values()));
}
