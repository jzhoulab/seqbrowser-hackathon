import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// 4173 is Vite's default preview port and is often already taken by an unrelated
// project, in which case reuseExistingServer would silently test the wrong app.
const port = Number(process.env.CZ_E2E_PORT ?? 4271);
const baseURL = `http://127.0.0.1:${port}`;

// A CI runner (two vCPUs, cold caches, no GPU) prepares a model and computes
// a window several times slower than a laptop, and the first model of a run
// also downloads the WASM runtime. The suite asserts what settles, not how
// fast, so the budgets stretch there rather than the tests being tuned to one
// machine.
const onCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: onCi ? 150_000 : 30_000,
  expect: {
    timeout: onCi ? 15_000 : 5_000,
  },
  // The demo tracks stream from hgdownload.soe.ucsc.edu (see
  // src/features/genome/demoData.ts -- they are far too large to bundle), so the
  // suite has a genuine external dependency. Sustained request volume across the
  // run intermittently draws net::ERR_CONNECTION_REFUSED, which is transport
  // noise rather than a regression. Retry rather than let that fail a run.
  retries: 1,
  workers: 1,
  reporter: 'list',
  fullyParallel: false,
  webServer: {
    // The preview profile: every model present, general branding. Matches vitest.
    // Its own dependency cache (see vite.config.ts): a test run must not reload
    // the developer's tabs on their own dev server.
    // The extension, when the caller set one (npm run test:e2e does), reaches
    // the dev server through the environment it inherits.
    command: `VITE_CACHE_DIR=node_modules/.vite-e2e VITE_SITE_PROFILE=dev npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    // Playwright spawns the server from this config's directory. Vite resolves
    // index.html against cwd, so from tests/ it serves 404 and the suite times
    // out waiting for the root. `npm run dev` used to hide this by always
    // running from the package root.
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL,
    headless: true,
  },
});
