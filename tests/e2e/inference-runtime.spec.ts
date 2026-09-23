import { expect, test } from '@playwright/test';

// onnxruntime-web can only use multi-threaded WASM when the page is cross-origin
// isolated, which depends on the COOP/COEP headers set in vite.config.ts. Losing
// those headers does not break anything visibly — inference just silently drops to
// a single core — so assert the capability directly.
test('page is cross-origin isolated so inference can use WASM threads', async ({ page }) => {
  await page.goto('/');

  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  expect(isolated).toBe(true);

  const hasSharedArrayBuffer = await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined');
  expect(hasSharedArrayBuffer).toBe(true);
});
