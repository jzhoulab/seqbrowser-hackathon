import type { TrackFeature, TrackKind } from '../types';

export type MockFetchParams = {
  trackId: string;
  kind: TrackKind;
  chr: string;
  start: number;
  end: number;
  resolutionBp: number;
  signal?: AbortSignal;
};

function hash32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function seededNoise(index: number, seed: number): number {
  const value = hash32(`${seed}|${index}`);
  return (value & 0xffff) / 0xffff;
}

function smoothNoiseAt(bp: number, scaleBp: number, seed: number): number {
  const x = bp / scaleBp;
  const x0 = Math.floor(x);
  const t = smoothstep(x - x0);
  const n0 = seededNoise(x0, seed);
  const n1 = seededNoise(x0 + 1, seed);
  return n0 * (1 - t) + n1 * t;
}

function signalAt(bp: number, trackSeed: number): number {
  const phaseA = ((trackSeed >>> 4) & 4095) / 4095;
  const phaseB = ((trackSeed >>> 12) & 4095) / 4095;
  const phaseC = ((trackSeed >>> 20) & 1023) / 1023;

  const waveA = 0.5 + 0.5 * Math.sin(bp / 290_000 + phaseA * Math.PI * 2);
  const waveB = 0.5 + 0.5 * Math.sin(bp / 75_000 + phaseB * Math.PI * 2);
  const waveC = 0.5 + 0.5 * Math.sin(bp / 11_500 + phaseC * Math.PI * 2);

  const noiseCoarse = smoothNoiseAt(bp, 180_000, trackSeed ^ 0xa8f31);
  const noiseMedium = smoothNoiseAt(bp, 42_000, trackSeed ^ 0x52b7d);
  const noiseFine = smoothNoiseAt(bp, 9_500, trackSeed ^ 0x1296f);

  const mixed =
    waveA * 0.34 +
    waveB * 0.26 +
    waveC * 0.17 +
    noiseCoarse * 0.11 +
    noiseMedium * 0.08 +
    noiseFine * 0.04;

  return clamp01(mixed);
}

function averageSignal(startBp: number, endBp: number, trackSeed: number): number {
  const span = Math.max(1, endBp - startBp);
  const sampleCount = span <= 200 ? 2 : span <= 4_000 ? 3 : 4;
  let total = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const t = (index + 0.5) / sampleCount;
    const sampleBp = startBp + span * t;
    total += signalAt(sampleBp, trackSeed);
  }

  return total / sampleCount;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchMockTrackWindow(params: MockFetchParams): Promise<TrackFeature[]> {
  const { trackId, kind, chr, start, end, resolutionBp, signal } = params;
  const span = Math.max(1, end - start);
  const targetSamples = 900;
  const bucketBp = Math.max(40, Math.floor(span / targetSamples), resolutionBp);
  const firstBucket = Math.floor(start / bucketBp) - 1;
  const lastBucket = Math.ceil(end / bucketBp) + 1;
  const trackSeed = hash32(`${trackId}|${chr}`);

  const simulatedLatency = 24 + (hash32(`${trackId}|${chr}|${Math.floor(start / 10_000)}`) % 67);
  await delay(simulatedLatency, signal);

  const features: TrackFeature[] = [];

  if (kind === 'annotation') {
    const useDensitySummary = resolutionBp >= 8_000;
    if (useDensitySummary) {
      const summaryBucketBp = Math.max(12_000, Math.floor(resolutionBp * 1.75));
      const firstSummaryBucket = Math.floor(start / summaryBucketBp) - 1;
      const lastSummaryBucket = Math.ceil(end / summaryBucketBp) + 1;

      for (
        let summaryBucket = firstSummaryBucket;
        summaryBucket <= lastSummaryBucket;
        summaryBucket += 1
      ) {
        const fStart = summaryBucket * summaryBucketBp;
        const fEnd = (summaryBucket + 1) * summaryBucketBp;
        const sampleBp = (fStart + fEnd) * 0.5;
        const score = clamp01(
          smoothNoiseAt(sampleBp, 260_000, trackSeed ^ 0x61f1) * 0.56 +
            smoothNoiseAt(sampleBp, 74_000, trackSeed ^ 0x93ac) * 0.29 +
            smoothNoiseAt(sampleBp, 19_000, trackSeed ^ 0x1bd6) * 0.15,
        );

        if (score < 0.04) {
          continue;
        }

        features.push({
          start: fStart,
          end: fEnd,
          score,
          renderMode: 'density',
        });
      }

      return features;
    }

    const anchorBp = 18_000;
    const firstAnchor = Math.floor(start / anchorBp) - 8;
    const lastAnchor = Math.ceil(end / anchorBp) + 8;

    for (let anchor = firstAnchor; anchor <= lastAnchor; anchor += 1) {
      const seed = hash32(`${trackSeed}|anno|${anchor}`);
      const visibility = (seed & 1023) / 1023;
      if (visibility < 0.93) {
        continue;
      }

      const offset = (seed >>> 12) % anchorBp;
      const widthBp = 2_800 + ((seed >>> 18) % 22_000);
      const fStart = Math.max(1, anchor * anchorBp + offset);
      const fEnd = fStart + widthBp;
      const score = 0.25 + (((seed >>> 24) & 255) / 255) * 0.75;
      const strandSeed = (seed >>> 10) % 3;
      const strand = strandSeed === 0 ? '+' : strandSeed === 1 ? '-' : '.';

      if (fEnd < start || fStart > end) {
        continue;
      }

      features.push({
        start: fStart,
        end: fEnd,
        score,
        label: `feat_${Math.abs(anchor)}`,
        strand,
        renderMode: 'interval',
      });
    }

    return features;
  }

  for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
    const fStart = bucket * bucketBp;
    const fEnd = (bucket + 1) * bucketBp;
    const score = averageSignal(fStart, fEnd, trackSeed);

    features.push({
      start: fStart,
      end: fEnd,
      score,
    });
  }

  return features;
}
