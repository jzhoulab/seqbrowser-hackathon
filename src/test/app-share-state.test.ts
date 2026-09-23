import { describe, expect, it } from 'vitest';

import {
  appShareStateEquals,
  normalizeAppShareState,
  resolvePanelMode,
  type AppShareState,
  type NormalizeOptions,
} from '../features/session/appShareState';

const options: NormalizeOptions = {
  defaultAssemblyId: 'hg38',
  defaultChr: 'chr1',
  defaultSearch: '',
  defaultBinScale: 2.4,
  minBinScale: 0.5,
  maxBinScale: 6,
  defaultActivePanel: 'none',
  defaultNavigatorTrackId: '__ideogram__',
  minBpPerPx: 0.15,
  maxBpPerPx: 2_700_000,
  chrLengthById: {
    chr1: 1_000,
  },
};

describe('appShareState normalization', () => {
  it('preserves the first-class Models panel', () => {
    expect(resolvePanelMode('models')).toBe('models');
    expect(normalizeAppShareState({ activePanel: 'models' }, options).activePanel).toBe('models');
  });

  it('falls back to defaults for missing payloads', () => {
    expect(normalizeAppShareState(undefined, options)).toEqual<AppShareState>({
      assemblyId: 'hg38',
      chr: 'chr1',
      search: '',
      binScale: 2.4,
      activePanel: 'none',
      navigatorTrackId: '__ideogram__',
      centerBp: undefined,
      bpPerPx: undefined,
    });
  });

  it('supports legacy panel flag and clamps numeric fields', () => {
    const normalized = normalizeAppShareState(
      {
        assemblyId: 'hg19',
        chr: 'chr1',
        search: 'peak',
        activePanel: 'invalid-panel',
        isPanelOpen: true,
        navigatorTrackId: '',
        binScale: 99,
        centerBp: 5_000,
        bpPerPx: 1e-6,
      },
      options,
    );

    expect(normalized).toEqual<AppShareState>({
      assemblyId: 'hg19',
      chr: 'chr1',
      search: 'peak',
      binScale: 6,
      activePanel: 'none',
      navigatorTrackId: '__ideogram__',
      centerBp: 1_000,
      bpPerPx: 0.15,
    });
  });

  it('accepts numeric strings for backward compatibility', () => {
    const normalized = normalizeAppShareState(
      {
        chr: 'chr1',
        binScale: '3.1415926535',
        centerBp: '900.6',
        bpPerPx: '1234.56789123',
      },
      options,
    );

    expect(normalized.binScale).toBe(3.1416);
    expect(normalized.centerBp).toBe(901);
    expect(normalized.bpPerPx).toBe(1234.567891);
  });

  it('provides strict equality helper for canonical share states', () => {
    const left: AppShareState = {
      assemblyId: 'hg38',
      chr: 'chr1',
      search: 'x',
      binScale: 2,
      activePanel: 'tracks',
      navigatorTrackId: '__ideogram__',
      centerBp: 100,
      bpPerPx: 10,
    };
    const right: AppShareState = { ...left };

    expect(appShareStateEquals(left, right)).toBe(true);
    expect(appShareStateEquals(left, { ...right, centerBp: 101 })).toBe(false);
  });
});
