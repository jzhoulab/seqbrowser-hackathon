import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * The build-time half of a site extension (see src/features/site/extension.ts):
 * a `site-extension.json` beside the extension module.
 */
type ExtensionManifest = {
  /** <title> and favicon per profile id, for the static shell. */
  shell?: Record<string, { title: string; favicon: string | null }>;
  /** A directory, relative to the manifest, copied into dist/ verbatim and served in dev. */
  assetsDir?: string;
};

// The static shell (<title>, favicon) cannot read the site profile the way the
// app can, so this fills it in at build time from the same VITE_SITE_PROFILE the
// app is built with. Kept deliberately tiny and duplicated from profile.ts rather
// than importing it: Vite config runs in Node before the app's import.meta.env
// exists, so the module cannot be shared without a second build step.
const SHELL: Record<string, { title: string; favicon: string | null }> = {
  seqbrowser: { title: 'Seq', favicon: null },
  dev: { title: 'Seq · preview', favicon: null },
};

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.czpack': 'application/json',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

export function readExtensionManifest(extensionDir: string | undefined): ExtensionManifest {
  if (!extensionDir) return {};
  const path = join(extensionDir, 'site-extension.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ExtensionManifest;
}

/** The extension's assets directory, absolute, or null when it has none. */
export function extensionAssetsDir(extensionDir: string | undefined): string | null {
  const manifest = readExtensionManifest(extensionDir);
  if (!extensionDir || !manifest.assetsDir) return null;
  const dir = resolve(extensionDir, manifest.assetsDir);
  return existsSync(dir) ? dir : null;
}

export function siteShellPlugin(profileId: string | undefined, extensionDir?: string): Plugin {
  const manifest = readExtensionManifest(extensionDir);
  const shells = { ...SHELL, ...(manifest.shell ?? {}) };
  const shell = shells[profileId ?? ''] ?? SHELL.seqbrowser;
  const assets = extensionAssetsDir(extensionDir);
  let config: ResolvedConfig;

  return {
    name: 'site-shell',
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml(html) {
      return html
        .replace('%VITE_SITE_TITLE%', shell.title)
        .replace(
          '%VITE_SITE_FAVICON%',
          shell.favicon ? `<link rel="icon" type="image/png" href="${shell.favicon}" />` : '',
        );
    },
    // In dev the extension's assets are served at their own paths, as if they
    // were in public/: a pack at assets/computational/packs/x.czpack answers at
    // /computational/packs/x.czpack.
    configureServer(server) {
      if (!assets) return;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '/').split('?')[0]!;
        const file = normalize(join(assets, decodeURIComponent(url)));
        if (!file.startsWith(assets) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    // In a build they are copied into dist/ verbatim, after Vite has written
    // its own output. Vite runs this for the worker bundle too; the copy is
    // idempotent, so that is harmless.
    closeBundle() {
      if (!assets || config.command !== 'build') return;
      cpSync(assets, config.build.outDir, { recursive: true });
      console.log(`  site extension: copied assets from ${assets}`);
    },
  };
}
