import { describe, expect, it } from 'vitest';

import {
  buildLinkedSignalViewportKey,
  computeVisibleSignalDomain,
  resolveEffectiveSignalScale,
  trackUsesSignedSignalScale,
} from '../lib/trackSignalScale';
import type {
  ComputationalPackManifest,
  TrackFeature,
  TrackSpec,
  ViewportState,
} from '../types';

const pack: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'model',
  name: 'Model',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/model.onnx' },
  subtracks: [
    {
      id: 'positive',
      name: 'Positive',
      kind: 'signal',
      color: '#123456',
      height: 80,
      outputName: 'positive',
      scaleMode: 'positive',
    },
    {
      id: 'signed',
      name: 'Signed',
      kind: 'signal',
      color: '#654321',
      height: 80,
      outputName: 'signed',
      scaleMode: 'signed',
    },
  ],
};

const viewport: ViewportState = {
  assemblyId: 'hg38',
  chr: 'chr7',
  chrLength: 100_000,
  widthPx: 1_000,
  centerBp: 500,
  bpPerPx: 1,
  range: { start: 0, end: 1_000, span: 1_000 },
};

const features: TrackFeature[] = [
  { start: 0, end: 100, score: -12, seriesIndex: 0 },
  { start: 100, end: 200, score: 3, seriesIndex: 0 },
  { start: 200, end: 300, score: -8, seriesIndex: 1 },
  { start: 2_000, end: 2_100, score: 99, seriesIndex: 1 },
];

function computationalTrack(seriesSubtrackIds?: string[]): TrackSpec {
  return {
    id: 'track',
    name: 'Model output',
    kind: 'signal',
    color: '#123456',
    height: 80,
    source: {
      type: 'computational',
      packUrl: '/pack.czpack',
      pack,
      subtrack: pack.subtracks[0],
      seriesSubtrackIds,
    },
  };
}

describe('visible signal domains', () => {
  it('anchors a positive signal at zero and ignores off-screen values', () => {
    expect(computeVisibleSignalDomain(computationalTrack(), viewport, features)).toEqual({
      min: 0,
      max: 3,
    });
  });

  it('makes the whole composite symmetric when any represented series is signed', () => {
    const track = computationalTrack(['positive', 'signed']);
    expect(trackUsesSignedSignalScale(track)).toBe(true);
    expect(computeVisibleSignalDomain(track, viewport, features)).toEqual({
      min: -12,
      max: 12,
    });
  });

  it('auto-detects signed ordinary signals instead of hiding their negative values', () => {
    const ordinary: TrackSpec = {
      id: 'ordinary',
      name: 'Per-base contribution',
      kind: 'signal',
      color: '#123456',
      height: 80,
      source: { type: 'bigwig', url: '/contribution.bw' },
    };
    expect(computeVisibleSignalDomain(ordinary, viewport, features)).toEqual({ min: -12, max: 12 });
  });
});

describe('effective signal scale', () => {
  it('uses linked unions and exact fixed limits', () => {
    const linked = {
      ...computationalTrack(),
      yScale: { mode: 'linked' as const, groupId: 'comparison' },
    };
    expect(resolveEffectiveSignalScale(linked, { min: 0, max: 3 }, { min: -8, max: 20 }))
      .toEqual({ mode: 'linked', domain: { min: -8, max: 20 } });

    const fixed = {
      ...computationalTrack(),
      yScale: { mode: 'fixed' as const, min: -0.002, max: 2_000 },
    };
    expect(resolveEffectiveSignalScale(fixed, { min: 0, max: 3 }, null))
      .toEqual({ mode: 'fixed', domain: { min: -0.002, max: 2_000 } });
  });

  it('keys linked scales by assembly, chromosome, exact range, and resolution', () => {
    expect(buildLinkedSignalViewportKey(viewport, 4)).toBe(
      JSON.stringify(['hg38', 'chr7', 0, 1_000, 4]),
    );
    expect(buildLinkedSignalViewportKey({ ...viewport, chr: 'chr8' }, 4)).not.toBe(
      buildLinkedSignalViewportKey(viewport, 4),
    );
  });
});
