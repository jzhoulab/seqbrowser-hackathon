import { describe, expect, it } from 'vitest';
import { isUnderViewPath, resolveSiteView, type SiteProfile } from '../features/site/profile';

// One build, possibly two views: the profile at `/`, and -- when the build
// carries another profile with a view path, through a site extension -- that
// product under its path. The view is the only thing the app reads.

const DEV_LIKE: SiteProfile = {
  id: 'dev',
  brand: { name: 'Sequence Browser', tagline: 'Preview', logoUrl: null },
  models: {},
  navigator: 'ideogram',
  landing: { kind: 'default' },
};

const PUBLIC_LIKE: SiteProfile = { ...DEV_LIKE, id: 'seqbrowser' };

const CARRIED: SiteProfile = {
  id: 'reef',
  brand: { name: 'Reef', tagline: 'A product built on the browser', logoUrl: '/reef-mark.png' },
  models: { autoMountModelId: 'reef', leadModelId: 'reef' },
  navigator: 'gene-annotation',
  landing: { kind: 'model-demo', modelId: 'reef' },
  viewPath: '/reef',
};

const WITH_EXTENSION = [PUBLIC_LIKE, DEV_LIKE, CARRIED];
const WITHOUT_EXTENSION = [PUBLIC_LIKE, DEV_LIKE];

describe('resolveSiteView', () => {
  it('serves the profile itself at the root', () => {
    const view = resolveSiteView(DEV_LIKE, '/', WITH_EXTENSION);
    expect(view.path).toBe('/');
    expect(view.profileId).toBe('dev');
    expect(view.brand.name).toBe('Sequence Browser');
    expect(view.landing).toEqual({ kind: 'default' });
    expect(view.models.leadModelId).toBeUndefined();
  });

  it('serves a carried product under its view path', () => {
    for (const pathname of ['/reef', '/reef/', '/reef/anything']) {
      const view = resolveSiteView(DEV_LIKE, pathname, WITH_EXTENSION);
      expect(view.path).toBe('/reef');
      expect(view.profileId).toBe('dev');
      expect(view.brand.name).toBe('Reef');
      expect(view.brand.logoUrl).toBe('/reef-mark.png');
      expect(view.models.autoMountModelId).toBe('reef');
      expect(view.navigator).toBe('gene-annotation');
      expect(view.landing).toEqual({ kind: 'model-demo', modelId: 'reef' });
      expect(view.models.leadModelId).toBe('reef');
    }
  });

  it('does not mistake a path that merely starts with the letters', () => {
    expect(isUnderViewPath('/reefknot', '/reef')).toBe(false);
    expect(resolveSiteView(DEV_LIKE, '/reefknot', WITH_EXTENSION).brand.name).toBe('Sequence Browser');
  });

  it('ignores the path on a build that does not carry the product', () => {
    const view = resolveSiteView(PUBLIC_LIKE, '/reef', WITHOUT_EXTENSION);
    expect(view.path).toBe('/');
    expect(view.brand.name).toBe('Sequence Browser');
    expect(view.models.autoMountModelId).toBeUndefined();
  });

  it("a product's own build is that product at every path", () => {
    const view = resolveSiteView(CARRIED, '/reef/anything', WITH_EXTENSION);
    expect(view.path).toBe('/');
    expect(view.profileId).toBe('reef');
    expect(view.brand.name).toBe('Reef');
  });
});
