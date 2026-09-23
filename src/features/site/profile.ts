import { siteExtension } from 'virtual:site-extension';

/**
 * Site profiles.
 *
 * One codebase serves several hostnames, each with its own identity: what the
 * masthead says, which model mounts itself, and what a first visit opens on.
 * That is the same idea as a UCSC track hub -- the data and the browser are
 * shared, the hub decides what a visitor sees.
 *
 * Two profiles are built in: the public browser and its preview. A product built
 * on the browser brings its own profile through a site extension
 * (src/features/site/extension.ts), from a repository of its own, along with its
 * models and marks; nothing about it is in this repository. A profile is chosen
 * at BUILD time by VITE_SITE_PROFILE.
 *
 * Everything in here is descriptive. Nothing should special-case a profile id --
 * if a behaviour needs to differ per site, add a field that names the behaviour.
 */

/** 'seqbrowser' and 'dev' are built in; an extension's profiles add their own ids. */
export type SiteProfileId = string;

export type SiteBrand = {
  /** Product name: the <h1>, the <title>, the gallery card. */
  name: string;
  /** One line under the name. Empty string renders nothing. */
  tagline: string;
  /** Path under public/ (or the extension's assets) for the masthead mark and favicon, or null for the CSS mark alone. */
  logoUrl: string | null;
};

export type SiteModels = {
  /**
   * A catalog entry that mounts itself once the view is narrow enough to
   * score, so its rows are simply there when a locus is on screen, and that
   * mounts on the first edit of the sequence. A general-purpose browser leaves
   * this unset, because a model appearing uninvited is not what "add a track"
   * means there.
   */
  autoMountModelId?: string;
  /**
   * The catalog entry the Models panel lists first; the rest keep catalog
   * order. Absent: the catalog order as it is.
   */
  leadModelId?: string;
};

export type SiteProfile = {
  id: SiteProfileId;
  brand: SiteBrand;
  models: SiteModels;
  /** Which chromosome-level navigator a first visit gets. */
  navigator: 'ideogram' | 'gene-annotation';
  /**
   * What a first visit with no session in the URL opens on: the browser's
   * default locus, or a catalog model's demo (the model prepared and mounted,
   * the view on the demo locus read on its strand) -- a splice-site browser
   * landing on a whole chromosome with nothing scored would be a blank first
   * screen.
   */
  landing: SiteLanding;
  /**
   * A path prefix under which OTHER builds that carry this profile serve it:
   * the preview host shows the shared browser at `/` and this product at its
   * own path, from one deployment. Absent: the profile is only ever a build's
   * own identity.
   */
  viewPath?: `/${string}`;
};

export type SiteLanding = { kind: 'default' } | { kind: 'model-demo'; modelId: string };

/**
 * A view is a profile as served at one path. A build has one profile; when it
 * also carries a profile with a `viewPath`, that path serves the other product's
 * identity. Everything the app reads about its identity comes from the view,
 * never from the profile directly.
 */
export type SiteView = Omit<SiteProfile, 'id' | 'viewPath'> & {
  profileId: SiteProfileId;
  /** The path prefix this view is served under. */
  path: string;
};

const SEQBROWSER: SiteProfile = {
  id: 'seqbrowser',
  brand: {
    name: 'Seq',
    tagline: 'Real-time sequence-model genome browser',
    logoUrl: null,
  },
  models: {},
  navigator: 'ideogram',
  landing: { kind: 'default' },
};

// The preview host: general branding, so what is being tested is the shared
// browser rather than one site's identity. With an extension it also serves the
// extension's products under their view paths.
const DEV: SiteProfile = {
  id: 'dev',
  brand: {
    name: 'Seq',
    tagline: 'Preview',
    logoUrl: null,
  },
  models: {},
  navigator: 'ideogram',
  landing: { kind: 'default' },
};

/** Every profile this build knows: the two built in, then the extension's. */
export const SITE_PROFILES: readonly SiteProfile[] = [SEQBROWSER, DEV, ...siteExtension.profiles];

/** An unknown or missing profile id is the public site, never a preview. */
export function resolveSiteProfileId(
  raw: string | undefined,
  profiles: readonly SiteProfile[] = SITE_PROFILES,
): SiteProfileId {
  return raw && profiles.some((profile) => profile.id === raw) ? raw : 'seqbrowser';
}

const PROFILE_ID = resolveSiteProfileId(import.meta.env.VITE_SITE_PROFILE);
export const SITE_PROFILE: SiteProfile =
  SITE_PROFILES.find((profile) => profile.id === PROFILE_ID) ?? SEQBROWSER;

/** Whether a pathname falls under a view path: the path itself or anything beneath it. */
export function isUnderViewPath(pathname: string, viewPath: string): boolean {
  return pathname === viewPath || pathname.startsWith(`${viewPath}/`);
}

function viewOf(profile: SiteProfile, source: SiteProfile, path: string): SiteView {
  return {
    profileId: profile.id,
    brand: source.brand,
    models: source.models,
    navigator: source.navigator,
    landing: source.landing,
    path,
  };
}

/**
 * The view for a path. A path under another carried profile's `viewPath` is
 * that product: its name, mark, tagline, auto-mount and landing. Every other
 * path is the profile as it is.
 */
export function resolveSiteView(
  profile: SiteProfile,
  pathname: string,
  profiles: readonly SiteProfile[] = SITE_PROFILES,
): SiteView {
  for (const candidate of profiles) {
    if (candidate.id === profile.id || !candidate.viewPath) continue;
    if (isUnderViewPath(pathname, candidate.viewPath)) {
      return viewOf(profile, candidate, candidate.viewPath);
    }
  }
  return viewOf(profile, profile, '/');
}

/** This page's view: the build's profile, as served at the current path. */
export const SITE_VIEW: SiteView = resolveSiteView(
  SITE_PROFILE,
  typeof window === 'undefined' ? '/' : window.location.pathname,
);
