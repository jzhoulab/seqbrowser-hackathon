import { useEffect, useState } from 'react';
import { fetchSignalDistribution } from '../data/bbiDataSource';
import type { SignalDistribution } from '../lib/signalDistribution';
import type { TrackSpec } from '../types';

type LoadedDistribution = {
  key: string;
  value: SignalDistribution | null;
};

/**
 * Lazily load the genome-wide value distribution for a bigWig signal track.
 *
 * Deliberately off the render path: this is one chromosome-wide summary read per
 * (file, chromosome, zoom level), cached in the data layer, and only requested for
 * tracks that are actually mounted. A failure is not surfaced — the track simply
 * renders without value context.
 *
 * The result is keyed, so a distribution loaded for one chromosome or zoom level is
 * never shown against another.
 */
export function useSignalDistribution(
  track: TrackSpec,
  chr: string,
  resolutionBp: number,
): SignalDistribution | null {
  const [loaded, setLoaded] = useState<LoadedDistribution | null>(null);
  const source = track.source;
  const url = source.type === 'bigwig' && track.kind === 'signal' ? source.url : null;
  const key = url ? `${url}|${chr}|${resolutionBp}` : '';

  useEffect(() => {
    if (!url) {
      return;
    }

    let cancelled = false;
    void fetchSignalDistribution({ type: 'bigwig', url }, chr, resolutionBp)
      .then((value) => {
        if (!cancelled) {
          setLoaded({ key, value });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ key, value: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chr, key, resolutionBp, url]);

  return url && loaded?.key === key ? loaded.value : null;
}
