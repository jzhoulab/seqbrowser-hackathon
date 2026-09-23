import { closeWorkspaceTools, openLibrary, toggleModels } from './workspace';
import { expect, test, type Page } from '@playwright/test';

async function addCatalogModel(page: Page, modelId: string) {
  await toggleModels(page);
  const modelCard = page.locator(`.hf-model-entry[data-model-id="${modelId}"]`);
  await expect(modelCard).toBeVisible();
  await modelCard.getByRole('button', { name: 'Run at current locus' }).click();
  // The first model of a run also fetches the WASM runtime; a cold CI runner
  // needs well over the default budget for that.
  await expect(page.locator(`.hf-model-group[data-model-id="${modelId}"]`)).toBeVisible({ timeout: 60_000 });
}

const BLOCKED_RUNTIME_PATTERNS = [
  'ArrayBuffer at index 0 is already detached',
  'failed to call OrtRun',
  'no available backend found',
  'Unable to preventDefault inside passive event listener invocation',
];

function collectRuntimeIssues(consoleErrors: string[], pageErrors: string[]): string[] {
  const all = [...consoleErrors, ...pageErrors];
  return all.filter((entry) => BLOCKED_RUNTIME_PATTERNS.some((pattern) => entry.includes(pattern)));
}

test('exploratory: interactive computational workflow remains stable', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/?debug=1');
  await addCatalogModel(page, 'seqbro2-puffin');
  await addCatalogModel(page, 'vibe-motifmatch');

  await closeWorkspaceTools(page);
  await page.getByRole('button', { name: 'Zoom to base resolution' }).click();
  await expect(page.locator('.hf-compute-debug')).toBeVisible();

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.focus();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('ArrowRight');
  }
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('=');
  }
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('ArrowLeft');
  }

  await openLibrary(page);
  await expect(page.getByLabel('Track manager rows')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select results' }).check();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select results' }).check();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.getByRole('button', { name: 'Hidden', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select results' }).check();
  await page.getByRole('button', { name: 'Show', exact: true }).click();

  await page.getByLabel('Assembly').selectOption('mm10');
  await expect(page.getByLabel('Assembly')).toHaveValue('mm10');
  await page.getByLabel('Assembly').selectOption('hg38');
  await expect(page.getByLabel('Assembly')).toHaveValue('hg38');

  await expect(page.getByRole('button', { name: 'Notes' })).toHaveCount(0);
  await toggleModels(page);
  await expect(page.locator('.hf-model-entry[data-model-id="seqbro2-puffin"]')).toBeVisible();

  await expect
    .poll(async () => page.locator('.hf-scroll-indicator').count(), { timeout: 30_000 })
    .toBe(0);

  const issues = collectRuntimeIssues(consoleErrors, pageErrors);
  expect(issues, `Runtime issues found:\n${issues.join('\n')}`).toEqual([]);
});

test('exploratory: repeated computational import/delete does not poison render state', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/?debug=1');
  await toggleModels(page);
  await page.getByText('Add another model', { exact: true }).click();
  const sourceInput = page.getByLabel('Model pack URL or path');
  await sourceInput.fill('/computational/packs/seqbro2-puffin.czpack');

  // Import the same pack twice to stress shared cache/source keys.
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(page.locator('.hf-model-group[data-model-id="seqbro2-puffin"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(page.locator('.hf-model-group[data-model-id="seqbro2-puffin"]')).toHaveCount(2, { timeout: 30_000 });
  await closeWorkspaceTools(page);
  await page.getByRole('button', { name: 'Zoom to base resolution' }).click();

  await openLibrary(page);
  await expect(page.getByLabel('Track manager rows')).toBeVisible();

  // Delete one duplicated rendered plot and ensure the other instance still renders.
  // The collection header counts outputs in the compact library and matching
  // tracks in the full one; either wording is the same row.
  await page.getByRole('button', { name: /Puffin.*(outputs shown|matching tracks)/i }).first().click();
  const deleteButtons = page.getByRole('button', { name: 'Delete Prediction', exact: true });
  const deleteCount = await deleteButtons.count();
  if (deleteCount > 0) {
    await deleteButtons.first().click();
  }

  // The source filter's own Data button, not the Data tools panel beside it.
  await page.getByLabel('Track source filter').getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.locator('.track-row[data-model-id="seqbro2-puffin"]').first()).toBeVisible();

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.focus();
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('ArrowRight');
  }
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('ArrowLeft');
  }

  await expect
    .poll(async () => page.locator('.hf-scroll-indicator').count(), { timeout: 30_000 })
    .toBe(0);

  const issues = collectRuntimeIssues(consoleErrors, pageErrors);
  expect(issues, `Runtime issues found:\n${issues.join('\n')}`).toEqual([]);
});
