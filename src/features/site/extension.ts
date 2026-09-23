import type { ModelCatalogEntry } from '../models/catalog';
import type { SiteProfile } from './profile';

/**
 * A site extension: what a build can be given from outside this repository.
 *
 * The browser is generic. A product built on it -- a research model with its
 * own name, mark and landing page, whose checkpoints are not published -- lives
 * in a repository of its own and is supplied to the build as an extension: a
 * directory named by VITE_SITE_EXTENSION holding
 *
 *   site-extension.ts    this module's shape: the profiles the build may be or
 *                        serve, and the catalog entries to offer
 *   site-extension.json  the build-time half (see vite.site.ts): <title> and
 *                        favicon per profile id, and an assets directory copied
 *                        into dist/ verbatim, which is where the packs, the
 *                        checkpoints and the marks come from
 *
 * With no extension the build is the browser as it is: `siteExtension` resolves
 * to src/features/site/noExtension.ts, which offers nothing. That is the whole
 * mechanism by which unpublished material stays out of the open repository and
 * of any build made from it alone: there is nothing to gate, because there is
 * nothing there.
 */
export type SiteExtension = {
  /** Profiles this build may be (by VITE_SITE_PROFILE) or serve under a `viewPath`. */
  profiles: readonly SiteProfile[];
  /** Catalog entries, offered after the bundled models. */
  catalog: readonly ModelCatalogEntry[];
};
