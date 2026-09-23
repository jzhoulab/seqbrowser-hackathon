export type YScaleMode = 'local' | 'global';

export interface TrackSettings {
  color: string;
  height: number;
  yScaleMode: YScaleMode;
}

export type TrackSettingsPatch = Partial<TrackSettings>;
export type TrackSettingsOverride = Record<string, TrackSettingsPatch | undefined>;

export const DEFAULT_TRACK_SETTINGS: Readonly<TrackSettings> = Object.freeze({
  color: '#60a5fa',
  height: 76,
  yScaleMode: 'local',
});

function normalizeColor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeHeight(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}

function normalizeYScaleMode(value: YScaleMode | undefined, fallback: YScaleMode): YScaleMode {
  return value === 'global' || value === 'local' ? value : fallback;
}

export function mergeTrackSettings(
  defaults: TrackSettings = DEFAULT_TRACK_SETTINGS,
  override?: TrackSettingsPatch,
): TrackSettings {
  return {
    color: normalizeColor(override?.color, defaults.color),
    height: normalizeHeight(override?.height, defaults.height),
    yScaleMode: normalizeYScaleMode(override?.yScaleMode, defaults.yScaleMode),
  };
}

export function resolveTrackSettingsById(
  trackIds: readonly string[],
  overrides: TrackSettingsOverride = {},
  defaults: TrackSettings = DEFAULT_TRACK_SETTINGS,
): Record<string, TrackSettings> {
  const resolved: Record<string, TrackSettings> = {};

  for (const trackId of trackIds) {
    resolved[trackId] = mergeTrackSettings(defaults, overrides[trackId]);
  }

  return resolved;
}
