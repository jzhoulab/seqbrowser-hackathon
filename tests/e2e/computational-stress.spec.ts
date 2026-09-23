import { toggleModels } from './workspace';
import { expect, test, type Page } from '@playwright/test';

async function addCatalogModel(page: Page, modelId: string) {
  await toggleModels(page);
  const modelCard = page.locator(`.hf-model-entry[data-model-id="${modelId}"]`);
  await expect(modelCard).toBeVisible();
  await modelCard.getByRole('button', { name: 'Run at current locus' }).click();
  await expect(page.locator(`.hf-model-group[data-model-id="${modelId}"]`)).toBeVisible({ timeout: 30_000 });
}

function collectRelevantConsoleErrors(messages: string[]): string[] {
  const noise = [
    'Download the React DevTools',
    'NO_COLOR',
  ];
  return messages.filter((message) => {
    const text = message.trim();
    if (text.length === 0) {
      return false;
    }
    return !noise.some((fragment) => text.includes(fragment));
  });
}

test('computational stress pan/zoom keeps UI responsive and drains loading state', async ({ page }) => {
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

  await page.goto('/?debug=1&preset=stress');
  await addCatalogModel(page, 'seqbro2-puffin');
  await addCatalogModel(page, 'vibe-motifmatch');
  await page.getByRole('button', { name: 'Zoom to base resolution' }).click();

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.focus();

  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('ArrowRight');
    }
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('=');
    }
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('-');
    }
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('ArrowLeft');
    }
  }

  await expect(page.locator('.hf-compute-debug')).toBeVisible();
  await expect
    .poll(async () => page.locator('.hf-compute-debug-row').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);

  await expect
    .poll(
      async () => page.locator('.hf-scroll-indicator').count(),
      { timeout: 30_000 },
    )
    .toBe(0);

  const mergedErrors = [
    ...collectRelevantConsoleErrors(consoleErrors),
    ...pageErrors,
  ];
  const blockedPatterns = [
    'ArrayBuffer at index 0 is already detached',
    'failed to call OrtRun',
    'no available backend found',
    'Unable to preventDefault inside passive event listener invocation',
  ];

  const matched = mergedErrors.filter((entry) => blockedPatterns.some((pattern) => entry.includes(pattern)));
  expect(matched, `Unexpected runtime errors:\n${mergedErrors.join('\n')}`).toEqual([]);
});

test('computational composite plots keep their series after virtualization churn', async ({ page }) => {
  await page.goto('/?debug=1&preset=stress');
  await addCatalogModel(page, 'seqbro2-puffin');
  await page.getByRole('button', { name: 'Zoom to base resolution' }).click();

  const puffinScaleTopLabels = () =>
    page
      .locator('.track-row[data-model-id="seqbro2-puffin"]')
      .locator('.track-scale span:first-child')
      .allInnerTexts();

  await expect
    .poll(
      async () => (await puffinScaleTopLabels()).filter((value) => value.trim().length > 0).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(2);

  const before = (await puffinScaleTopLabels()).slice(0, 2);
  expect(new Set(before).size).toBeGreaterThanOrEqual(2);

  // Plain wheel is zoom; Shift+wheel scrolls the track list, which is what churns
  // virtualization here.
  const list = page.locator('.track-virtuoso');
  await page.keyboard.down('Shift');
  for (let index = 0; index < 35; index += 1) {
    await list.hover();
    await page.mouse.wheel(0, 1400);
  }
  for (let index = 0; index < 35; index += 1) {
    await list.hover();
    await page.mouse.wheel(0, -1400);
  }
  await page.keyboard.up('Shift');

  const prediction = page.locator(
    '.track-row[data-model-id="seqbro2-puffin"][data-output-ids="puffin-pred-plus puffin-pred-minus"]',
  );
  await expect(prediction).toBeVisible();
  await expect(prediction.locator('[data-series-id="puffin-pred-plus"]')).toHaveCount(1);
  await expect(prediction.locator('[data-series-id="puffin-pred-minus"]')).toHaveCount(1);
  await expect(page.locator('.track-row[data-output-id="puffin-effects-total"] .track-name'))
    .toHaveText('Total sequence effect');

  await expect
    .poll(
      async () => {
        const labels = (await puffinScaleTopLabels()).slice(0, 2);
        return new Set(labels).size;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(2);
});
