import { describe, expect, it } from 'vitest';
import {
  MAX_PERSISTED_MODELS,
  appShareStateEquals,
  normalizeAppShareState,
  persistedModelsEqual,
  type PersistedModel,
} from '../features/session/appShareState';

// Mounted models used to live only in memory, so every refresh -- and every shared
// link -- silently dropped them back to the demo tracks.

const options = {
  defaultAssemblyId: 'hg38',
  defaultChr: 'chr7',
  defaultSearch: '',
  defaultBinScale: 0.5,
  minBinScale: 0.5,
  maxBinScale: 4,
  defaultActivePanel: 'none' as const,
  defaultNavigatorTrackId: '__ideogram__',
};

const model = (over: Partial<PersistedModel> = {}): PersistedModel => ({
  url: '/computational/packs/demo-bars-2ch.czpack',
  id: 'demo-bars-2ch',
  shown: ['demo-bars-2ch-first', 'demo-bars-2ch-ism-first'],
  ...over,
});

describe('session model persistence', () => {
  it('round-trips a mounted model with its visible outputs', () => {
    const state = normalizeAppShareState({ models: [model()] }, options);
    expect(state.models).toEqual([model()]);
  });

  it('keeps the pack id beside the url, so a repointed url cannot substitute a model', () => {
    const state = normalizeAppShareState({ models: [model()] }, options);
    expect(state.models?.[0].id).toBe('demo-bars-2ch');
  });

  it('drops entries missing a url or id rather than failing the whole restore', () => {
    const state = normalizeAppShareState(
      { models: [{ url: '/a.czpack' }, { id: 'only-id' }, model(), 'nonsense', null] },
      options,
    );
    expect(state.models).toEqual([model()]);
  });

  it('collapses a duplicate instance of the same pack url', () => {
    const state = normalizeAppShareState({ models: [model(), model()] }, options);
    expect(state.models).toHaveLength(1);
  });

  it('caps how many models a link can carry', () => {
    const many = Array.from({ length: MAX_PERSISTED_MODELS + 6 }, (_, i) =>
      model({ id: `pack-${i}`, url: `/p-${i}.czpack` }),
    );
    expect(normalizeAppShareState({ models: many }, options).models).toHaveLength(MAX_PERSISTED_MODELS);
  });

  it('treats an absent models field as no models, not an empty session', () => {
    expect(normalizeAppShareState({}, options).models).toBeUndefined();
    expect(normalizeAppShareState({ models: [] }, options).models).toBeUndefined();
  });

  it('distinguishes an all-hidden model from one with outputs shown', () => {
    expect(persistedModelsEqual([model({ shown: [] })], [model()])).toBe(false);
  });

  it('makes the session comparer notice a model appearing or disappearing', () => {
    const base = normalizeAppShareState({}, options);
    const withModel = normalizeAppShareState({ models: [model()] }, options);
    expect(appShareStateEquals(base, withModel)).toBe(false);
    expect(appShareStateEquals(withModel, normalizeAppShareState({ models: [model()] }, options))).toBe(true);
  });
});
