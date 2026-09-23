import { closeWorkspaceTools, openModels, toggleModels } from './workspace';
import { expect, test } from '@playwright/test';

// Removing a model is one click, like adding it: Remove on its header row (or
// on its card in Models) unmounts every track of it, and the card offers to run
// it again.

test('a mounted model is removed from its header row, tracks and all', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await toggleModels(page);
  const panel = page.getByRole('region', { name: 'Sequence models' });
  const card = panel.locator('[data-model-id="seqbro2-puffin"]');
  await card.getByRole('button', { name: 'Try Puffin demo' }).click();
  await expect(page.getByLabel('Chr')).toHaveValue('chr7', { timeout: 60_000 });

  const header = page.locator('.hf-model-group[data-model-id="seqbro2-puffin"]');
  await expect(header).toBeVisible();
  await expect(page.locator('.track-row[data-model-id="seqbro2-puffin"]')).toHaveCount(2);
  // The demo closed the panel; the card shows Remove while the model is mounted.
  await header.getByRole('button', { name: 'Outputs' }).click();
  await expect(card.getByRole('button', { name: 'Remove Puffin' })).toBeVisible();

  // The tools panel is a dialog over the workspace, so the header row beneath it
  // is not reachable (by a test or by a finger) until it is closed.
  await closeWorkspaceTools(page);
  await header.getByRole('button', { name: 'Remove Puffin' }).click();
  await expect(header).toHaveCount(0);
  await expect(page.locator('.track-row[data-model-id="seqbro2-puffin"]')).toHaveCount(0);

  await openModels(page);
  await expect(card.getByRole('button', { name: 'Remove Puffin' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Run at current locus' })).toBeVisible();
});
