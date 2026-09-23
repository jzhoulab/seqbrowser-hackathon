import { toggleModels } from './workspace';
import { expect, test, type Page } from '@playwright/test';

// A refresh used to drop every mounted model: the session URL carried the viewport
// but nothing about which models were on screen.

const MODEL_ID = 'seqbro2-puffin';

async function mountModel(page: Page): Promise<void> {
  await toggleModels(page);
  const card = page.locator(`.hf-model-entry[data-model-id="${MODEL_ID}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Try .* demo|Run at current locus/ }).first().click();
  await expect(page.locator(`.hf-model-group[data-model-id="${MODEL_ID}"]`)).toBeVisible({ timeout: 30_000 });
}

test('a mounted model survives a reload', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await mountModel(page);

  // The model must reach the session URL before a reload can restore it. The
  // URL already carries a state string before any model is mounted (the
  // viewport), and the write that adds the model follows the mount by a
  // debounce; waiting for a non-null string took the pre-mount one on a slow
  // runner and then restored a session with no model in it. Wait for the
  // model itself.
  const readModels = () =>
    page.evaluate(() => {
      const encoded = new URL(window.location.href).searchParams.get('state');
      if (!encoded) return null;
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))) as { state?: { models?: { id: string }[] } };
      return decoded.state?.models?.map((model) => model.id) ?? null;
    });
  await expect.poll(readModels, { timeout: 15_000 }).toContain(MODEL_ID);
  const encoded = await page.evaluate(() => new URL(window.location.href).searchParams.get('state'));

  await page.goto(`/?state=${encoded}`);

  await expect(page.locator(`.hf-model-group[data-model-id="${MODEL_ID}"]`)).toBeVisible({ timeout: 45_000 });
});

test('an unresolvable model in a link is skipped, not fatal', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const encoded = await page.evaluate(() => {
    const state = {
      v: 1,
      state: {
        assemblyId: 'hg38',
        chr: 'chr7',
        search: '',
        binScale: 0.5,
        activePanel: 'none',
        navigatorTrackId: '__ideogram__',
        models: [{ url: '/computational/packs/does-not-exist.czpack', id: 'ghost' }],
      },
    };
    return btoa(JSON.stringify(state)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });

  await page.goto(`/?state=${encoded}`);

  // The rest of the session still loads.
  await expect(page.getByRole('heading', { name: 'Seq', exact: true })).toBeVisible();
  await expect(page.locator('.track-row').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.hf-model-group[data-model-id="ghost"]')).toHaveCount(0);
});
