import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTrackWindowCacheKey,
  parseTrackWindowCacheKey,
  trackDataLoader,
} from '../data/trackDataLoader';
import type { DataWindowSpec, TrackSpec, TrackWindowData } from '../types';

const track: TrackSpec = {
  id: 'resolution-cache-test',
  name: 'Prediction',
  kind: 'signal',
  color: '#77b6ff',
  height: 76,
  source: {
    type: 'computational',
    packUrl: '/resolution-cache-test.czpack',
    pack: {
      schemaVersion: 1,
      id: 'resolution-cache-test',
      name: 'Resolution cache test',
      sequenceProvider: { type: 'ucsc', genome: 'hg38' },
      model: { format: 'onnx', url: '/resolution-cache-test.onnx' },
      subtracks: [
        {
          id: 'prediction',
          name: 'Prediction',
          kind: 'signal',
          color: '#77b6ff',
          height: 76,
          outputName: 'prediction',
          groupId: 'overview',
        },
      ],
    },
    subtrack: {
      id: 'prediction',
      name: 'Prediction',
      kind: 'signal',
      color: '#77b6ff',
      height: 76,
      outputName: 'prediction',
      groupId: 'overview',
    },
  },
};

const largeFineSpec: DataWindowSpec = {
  key: 'chr1:100:500',
  requestStart: 100,
  requestEnd: 500,
  resolutionBp: 10,
};

const containedFineSpec: DataWindowSpec = {
  key: 'chr1:200:400',
  requestStart: 200,
  requestEnd: 400,
  resolutionBp: 10,
};

const containedCoarseSpec: DataWindowSpec = {
  ...containedFineSpec,
  resolutionBp: 20,
};

type LoaderInternals = {
  cache: Map<string, TrackWindowData>;
  inFlight: Map<string, Promise<TrackWindowData>>;
};

const loaderInternals = trackDataLoader as unknown as LoaderInternals;
const insertedKeys: string[] = [];

afterEach(() => {
  for (const key of insertedKeys.splice(0)) {
    loaderInternals.cache.delete(key);
    loaderInternals.inFlight.delete(key);
  }
});

describe('computational track data cache resolution', () => {
  it('includes normalized bin resolution in the post-inference cache key', () => {
    const fineKey = buildTrackWindowCacheKey(track, 'chr1', containedFineSpec);
    const coarseKey = buildTrackWindowCacheKey(track, 'chr1', containedCoarseSpec);

    expect(fineKey).not.toBe(coarseKey);
    expect(parseTrackWindowCacheKey(fineKey)?.tag).toBe('comp:r10');
    expect(parseTrackWindowCacheKey(coarseKey)?.tag).toBe('comp:r20');
  });

  it('reuses a covering binned cache entry only at the same resolution', () => {
    const key = buildTrackWindowCacheKey(track, 'chr1', largeFineSpec);
    const cached: TrackWindowData = {
      spec: largeFineSpec,
      features: [{ start: 100, end: 110, score: 1 }],
      fetchedAt: 1,
    };
    loaderInternals.cache.set(key, cached);
    insertedKeys.push(key);

    expect(trackDataLoader.peekWindow(track, 'chr1', containedFineSpec)).toBe(cached);
    expect(trackDataLoader.peekWindow(track, 'chr1', containedCoarseSpec)).toBeNull();
  });

  it('reuses a covering in-flight entry only at the same resolution', () => {
    const key = buildTrackWindowCacheKey(track, 'chr1', largeFineSpec);
    const request = Promise.resolve<TrackWindowData>({
      spec: largeFineSpec,
      features: [],
      fetchedAt: 1,
    });
    loaderInternals.inFlight.set(key, request);
    insertedKeys.push(key);

    expect(trackDataLoader.hasInFlightWindow(track, 'chr1', containedFineSpec)).toBe(true);
    expect(trackDataLoader.hasInFlightWindow(track, 'chr1', containedCoarseSpec)).toBe(false);
  });
});
