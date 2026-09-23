import { describe, expect, it } from 'vitest';

import {
  deleteTrack,
  normalizeTrackOrder,
  renameTrack,
  reorderTrack,
  toggleTrack,
  type TrackManagerItem,
} from '../features/tracks/manager';
import {
  DEFAULT_TRACK_SETTINGS,
  mergeTrackSettings,
  resolveTrackSettingsById,
  type TrackSettings,
  type TrackSettingsOverride,
} from '../features/tracks/settings';

const baseTracks: TrackManagerItem[] = [
  { id: 'a', name: 'Track A', enabled: true, order: 10 },
  { id: 'b', name: 'Track B', enabled: false, order: 20 },
  { id: 'c', name: 'Track C', enabled: true, order: 30 },
  { id: 'd', name: 'Track D', enabled: true, order: 40 },
];

describe('CZ-006 Track manager domain logic', () => {
  it('reorders a track to the requested index and keeps a dense stable order', () => {
    const next = reorderTrack(baseTracks, 'c', 0);

    expect(next.map((track) => track.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(next.map((track) => track.order)).toEqual([0, 1, 2, 3]);
  });

  it('toggles enabled state while preserving stable ordering', () => {
    const next = toggleTrack(baseTracks, 'b');

    expect(next.find((track) => track.id === 'b')?.enabled).toBe(true);
    expect(next.map((track) => track.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.map((track) => track.order)).toEqual([0, 1, 2, 3]);
  });

  it('renames a track and trims incoming whitespace', () => {
    const next = renameTrack(baseTracks, 'a', '  Updated A  ');

    expect(next.find((track) => track.id === 'a')?.name).toBe('Updated A');
    expect(next.map((track) => track.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('deletes a track and compacts ordering without disturbing survivors', () => {
    const next = deleteTrack(baseTracks, 'b');

    expect(next.map((track) => track.id)).toEqual(['a', 'c', 'd']);
    expect(next.map((track) => track.order)).toEqual([0, 1, 2]);
  });

  it('normalizes non-dense or duplicate order values with stable tie handling', () => {
    const noisy: TrackManagerItem[] = [
      { id: 'x', name: 'X', enabled: true, order: 10 },
      { id: 'y', name: 'Y', enabled: true, order: 10 },
      { id: 'z', name: 'Z', enabled: true, order: 3 },
      { id: 'w', name: 'W', enabled: true, order: 10 },
    ];

    const normalized = normalizeTrackOrder(noisy);

    expect(normalized.map((track) => track.id)).toEqual(['z', 'x', 'y', 'w']);
    expect(normalized.map((track) => track.order)).toEqual([0, 1, 2, 3]);
  });
});

describe('CZ-007 Track settings merge + defaults', () => {
  it('merges per-track override with defaults for missing fields', () => {
    const merged = mergeTrackSettings(DEFAULT_TRACK_SETTINGS, {
      color: '#f97316',
      yScaleMode: 'global',
    });

    expect(merged).toEqual<TrackSettings>({
      color: '#f97316',
      height: DEFAULT_TRACK_SETTINGS.height,
      yScaleMode: 'global',
    });
  });

  it('resolves settings for each track id using defaults when missing', () => {
    const overrides: TrackSettingsOverride = {
      b: { color: '#22c55e' },
      c: { height: 112, yScaleMode: 'global' },
    };

    const resolved = resolveTrackSettingsById(['a', 'b', 'c'], overrides);

    expect(resolved.a).toEqual(DEFAULT_TRACK_SETTINGS);
    expect(resolved.b).toEqual({
      ...DEFAULT_TRACK_SETTINGS,
      color: '#22c55e',
    });
    expect(resolved.c).toEqual({
      ...DEFAULT_TRACK_SETTINGS,
      height: 112,
      yScaleMode: 'global',
    });
  });

  it('falls back to defaults for invalid or empty override values', () => {
    const merged = mergeTrackSettings(DEFAULT_TRACK_SETTINGS, {
      color: '   ',
      height: -20,
      yScaleMode: 'local',
    });

    expect(merged).toEqual<TrackSettings>({
      color: DEFAULT_TRACK_SETTINGS.color,
      height: DEFAULT_TRACK_SETTINGS.height,
      yScaleMode: 'local',
    });
  });
});
