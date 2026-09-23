import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MODEL_CATALOG } from '../features/models/catalog';

/**
 * Every model the catalog offers must have the files it points at.
 *
 * This is the guard for a failure git will not flag. A branch that deletes a
 * pack it no longer uses, merged into one that still lists the model, resolves
 * cleanly: "deleted here, untouched there" needs no human. The catalog entry
 * survives, the assets do not, and the model lists in the panel and 404s on
 * load. That is exactly how Puffin and MotifMatch were lost merging
 * a model feature branch, and it was only caught by opening the app.
 *
 * Reads from public/ rather than a build so it fails on the commit that removed
 * the file, not on the deploy.
 */
const PUBLIC = join(process.cwd(), 'public');

// A site extension's assets are served at the same paths as public/ (see
// vite.site.ts). When the suite runs with one, a pack that is not bundled is
// looked for there, so a missing extension file fails exactly as a missing
// bundled one does.
const EXTENSION_ASSETS = (() => {
  const dir = process.env.VITE_SITE_EXTENSION;
  if (!dir) return null;
  // A named directory that is absent (a CI runner) is the same as none.
  const manifest = join(dir, 'site-extension.json');
  if (!existsSync(manifest)) return null;
  const assetsDir = (JSON.parse(readFileSync(manifest, 'utf8')) as { assetsDir?: string }).assetsDir;
  return assetsDir ? join(dir, assetsDir) : null;
})();

function publicPath(url: string): string {
  const rel = url.replace(/^\//, '');
  const bundled = join(PUBLIC, rel);
  if (existsSync(bundled) || !EXTENSION_ASSETS) return bundled;
  return join(EXTENSION_ASSETS, rel);
}

type PackTarget = { label: string; packUrl: string };

const targets: PackTarget[] = MODEL_CATALOG.flatMap((model) => [
  { label: model.name, packUrl: model.url },
  ...(model.variants ?? []).map((variant) => ({
    label: `${model.name} · ${variant.label}`,
    packUrl: variant.url,
  })),
]);

describe('every catalog entry has its assets', () => {
  it('offers at least one model', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)('$label: pack and checkpoint are present', ({ packUrl }) => {
    const packFile = publicPath(packUrl);
    expect(existsSync(packFile), `missing pack: ${packUrl}`).toBe(true);

    const pack = JSON.parse(readFileSync(packFile, 'utf8')) as { model?: { url?: string } };
    const modelUrl = pack.model?.url;
    expect(modelUrl, `pack declares no model url: ${packUrl}`).toBeTruthy();
    expect(existsSync(publicPath(modelUrl as string)), `missing checkpoint: ${modelUrl}`).toBe(true);
  });
});
