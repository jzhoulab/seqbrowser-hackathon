import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { siteShellPlugin } from './vite.site'

// A site extension (src/features/site/extension.ts): a directory outside this
// repository that supplies a product's profiles, catalog entries and assets.
// Absent, the build is the browser as it is, and `virtual:site-extension` is
// the empty extension.
// An extension is used only when its module is actually there. `npm test`
// names the models repository beside this checkout, which exists on a dev
// machine and not on a CI runner; a named directory that is missing must mean
// "no extension", not a broken import in every module that reads the catalog.
const requestedExtension = process.env.VITE_SITE_EXTENSION ? resolve(process.env.VITE_SITE_EXTENSION) : undefined
const extensionDir = requestedExtension && existsSync(resolve(requestedExtension, 'site-extension.ts'))
  ? requestedExtension
  : undefined
if (requestedExtension && !extensionDir) {
  console.warn(`site extension not found at ${requestedExtension}; building without one`)
}
const extensionModule = extensionDir
  ? resolve(extensionDir, 'site-extension.ts')
  : resolve(__dirname, 'src/features/site/noExtension.ts')

// Cross-origin isolation is what makes SharedArrayBuffer available, which is in
// turn what lets onnxruntime-web run multi-threaded WASM. Without these headers
// the inference worker is stuck on one core.
//
// Any host serving a production build must send the same two headers, or
// inference silently falls back to single-threaded.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), siteShellPlugin(process.env.VITE_SITE_PROFILE, extensionDir)],
  resolve: {
    alias: {
      'virtual:site-extension': extensionModule,
    },
  },
  // A second dev server on this checkout -- the e2e suite's -- must not share
  // the first's optimized-dependency cache: when one re-optimizes, tabs open on
  // the other reload mid-session. tests/playwright.config.ts points its server
  // at its own directory.
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  // The inference worker dynamically imports onnxruntime-web, which Rollup can only
  // code-split into an ES worker. The default 'iife' worker format fails the build.
  worker: {
    format: 'es',
  },
  // Dependencies the dev server cannot see from index.html: onnxruntime-web is
  // a dynamic import inside the inference worker, and bigwig-reader is reached
  // only through a data-source module. Left to discovery, Vite optimizes them
  // the first time a session touches a model, then RELOADS THE PAGE -- which
  // threw away the model preparation in progress and, on a cold CI runner
  // (a fresh node_modules every run), failed the first e2e test of every run.
  // Pre-bundling them at start-up means no mid-session reload, cold or warm.
  optimizeDeps: {
    include: ['onnxruntime-web/wasm', 'bigwig-reader', 'react-virtuoso'],
  },
  server: {
    headers: crossOriginIsolationHeaders,
    // The extension module lives outside the workspace, which Vite refuses to
    // serve unless told the directory is allowed.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), ...(extensionDir ? [extensionDir] : [])],
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  test: {
    environment: 'jsdom',
    include: ['src/test/**/*.test.{ts,tsx}'],
    // Tests run against the preview profile. `npm run test:ext` names the
    // models repository beside this checkout as the extension, which gives the
    // suite the dev extension's toy model for the ISM, family and
    // probability-axis tests; plain `npm test` (CI, a bare checkout) has no
    // extension, and those tests skip themselves.
    env: {
      VITE_SITE_PROFILE: 'dev',
    },
  },
})
