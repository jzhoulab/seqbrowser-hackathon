import { toggleModels } from './workspace';
import { expect, test } from '@playwright/test';

test('sequence models are a first-class, discoverable browser workflow', async ({ page }) => {
  await page.goto('/');

  const modelsButton = page.getByRole('navigation', { name: 'Browser tools' }).getByRole('button', { name: 'Models', exact: true });
  await expect(modelsButton).toBeVisible();

  await modelsButton.click();

  const modelsPanel = page.getByRole('region', { name: 'Sequence models' });
  await expect(modelsPanel).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Models', exact: true })).toBeVisible();
  await expect(modelsPanel.getByRole('heading', { name: 'Sequence models' })).toBeVisible();

  const puffin = modelsPanel.locator('[data-model-id="seqbro2-puffin"]');
  await expect(puffin.getByRole('heading', { name: 'Puffin' })).toBeVisible();
  await expect(puffin.getByText('hg38', { exact: true })).toBeVisible();
  await expect(puffin.getByText('100 genomic outputs', { exact: true })).toBeVisible();
  await expect(puffin.getByText('64 chart · 36 base-pair attribution', { exact: true })).toBeVisible();
  await expect(puffin.getByText('3-output overview · 100 available', { exact: true })).toBeVisible();
  await expect(puffin.getByText('Runs in this browser', { exact: true })).toBeVisible();
  await expect(puffin.getByRole('button', { name: 'Try Puffin demo' })).toBeVisible();
  await expect(puffin.getByRole('button', { name: 'Run at current locus' })).toBeVisible();
  await expect(puffin.getByRole('link', { name: 'Open Puffin homepage' })).toHaveAttribute(
    'href',
    'https://puffin.zhoulab.io/',
  );

  await expect(page.getByRole('complementary', { name: 'Computational buffer debug' })).toHaveCount(0);
});

test('the Puffin demo becomes ready as genome tracks and pauses on the wrong assembly', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('complementary', { name: 'Computational buffer debug' })).toHaveCount(0);
  await toggleModels(page);
  await page
    .getByRole('region', { name: 'Sequence models' })
    .locator('[data-model-id="seqbro2-puffin"]')
    .getByRole('button', { name: 'Try Puffin demo' })
    .click();

  await expect(page.getByLabel('Assembly')).toHaveValue('hg38');
  await expect(page.getByLabel('Chr')).toHaveValue('chr7');

  const puffinGroup = page.locator('.hf-model-group[data-model-id="seqbro2-puffin"]');
  await expect(puffinGroup).toBeVisible();
  await expect(puffinGroup).toContainText('3 shown · 100 available · hg38');

  const predictionPlot = page.locator(
    '.track-row[data-model-id="seqbro2-puffin"][data-output-ids*="puffin-pred-plus"]',
  );
  await expect(predictionPlot).toBeVisible();
  await expect(predictionPlot).toHaveAttribute(
    'data-output-ids',
    'puffin-pred-plus puffin-pred-minus',
  );
  await expect(predictionPlot).toHaveAttribute('data-series-count', '2');
  await expect(
    predictionPlot.locator('[data-series-id="puffin-pred-minus"]'),
  ).toHaveAttribute('data-series-style', 'dashed');

  const totalPlot = page.locator('.track-row[data-output-id="puffin-effects-total"]');
  await expect(totalPlot).toBeVisible();
  await expect(totalPlot).toHaveAttribute('data-series-count', '1');
  await expect(page.locator('.track-row[data-model-id="seqbro2-puffin"]')).toHaveCount(2);

  // The rail quiets once a model settles: the "Ready locally" status line is
  // removed rather than left on screen, so readiness is asserted on the state
  // attribute, which stays.
  await expect(puffinGroup).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(
    page.locator('.track-row[data-output-id="puffin-effects-total"] .track-scale-labels'),
  ).toContainText('−');
  await expect(page.getByRole('complementary', { name: 'Computational buffer debug' })).toHaveCount(0);

  await page.getByLabel('Assembly').selectOption('mm10');

  await expect(puffinGroup).toHaveAttribute('data-state', 'requires-assembly');
  await expect(puffinGroup.getByRole('status')).toHaveText('Requires hg38');
  await expect(puffinGroup.getByRole('button', { name: 'Switch to hg38' })).toBeVisible();
});

test('Puffin composes optional motif collections into color-coded plots', async ({ page }) => {
  await page.goto('/');
  await toggleModels(page);
  const panel = page.getByRole('region', { name: 'Sequence models' });
  const puffin = panel.locator('[data-model-id="seqbro2-puffin"]');
  await puffin.getByRole('button', { name: 'Try Puffin demo' }).click();

  const group = page.locator('.hf-model-group[data-model-id="seqbro2-puffin"]');
  await expect(group).toContainText('3 shown · 100 available · hg38');
  await group.getByRole('button', { name: 'Outputs' }).click();

  const installedPuffin = page.getByRole('region', { name: 'Sequence models' })
    .locator('[data-model-id="seqbro2-puffin"]');
  await installedPuffin.getByText('3 outputs shown · 100 available', { exact: true }).click();

  const activations = installedPuffin.locator('[data-output-group="motif-activations"]');
  await expect(activations).toContainText('0/18');
  await activations.getByRole('button', { name: 'Show' }).click();

  const activationPlot = page.locator(
    '.track-row[data-model-id="seqbro2-puffin"][data-output-group="motif-activations"]',
  );
  await expect(group).toContainText('21 shown · 100 available · hg38');
  await expect(activationPlot).toHaveCount(1);
  await expect(activationPlot).toHaveAttribute('data-series-count', '18');
  await expect(activationPlot.locator('.track-series-item')).toHaveCount(18);
  await expect(activationPlot.locator('[data-series-style="solid"]')).toHaveCount(18);

  const motifEffects = installedPuffin.locator('[data-output-group="motif-effects"]');
  const oppositeEffects = installedPuffin.locator('[data-output-group="opposite-motif-effects"]');
  await motifEffects.getByRole('button', { name: 'Show' }).click();
  await oppositeEffects.getByRole('button', { name: 'Show' }).click();

  const motifEffectPlot = page.locator(
    '.track-row[data-model-id="seqbro2-puffin"][data-output-group="motif-effects"]',
  );
  await expect(group).toContainText('57 shown · 100 available · hg38');
  await expect(motifEffectPlot).toHaveCount(1);
  await expect(motifEffectPlot).toHaveAttribute('data-series-count', '36');
  await expect(motifEffectPlot.locator('.track-series-item')).toHaveCount(36);
  await expect(motifEffectPlot.locator('[data-series-style="solid"]')).toHaveCount(18);
  await expect(motifEffectPlot.locator('[data-series-style="dashed"]')).toHaveCount(18);
  await expect(
    motifEffectPlot.locator('[data-series-id="puffin-opposite-motif-effect-1"]'),
  ).toHaveAttribute('data-series-style', 'dashed');
});

test('Puffin exposes a verified signed per-base attribution as DNA heights', async ({ page }) => {
  await page.goto('/');
  await toggleModels(page);
  const panel = page.getByRole('region', { name: 'Sequence models' });
  await panel.locator('[data-model-id="seqbro2-puffin"]')
    .getByRole('button', { name: 'Try Puffin demo' })
    .click();

  const group = page.locator('.hf-model-group[data-model-id="seqbro2-puffin"]');
  await group.getByRole('button', { name: 'Outputs' }).click();

  const installedPuffin = page.getByRole('region', { name: 'Sequence models' })
    .locator('[data-model-id="seqbro2-puffin"]');
  await installedPuffin.getByText('3 outputs shown · 100 available', { exact: true }).click();
  const contributionGroup = installedPuffin.locator('[data-output-group="bp-initiation-contributions"]');
  await contributionGroup.getByText('Choose motif contribution tracks', { exact: true }).click();
  await contributionGroup.getByRole('button', { name: 'Show YY1+ Base-pair → initiation' }).click();

  const contribution = page.locator(
    '.track-row[data-output-id="puffin-bp-initiation-contribution-1"]',
  );
  await expect(contribution).toBeVisible();
  await expect(contribution).toHaveAttribute('data-signal-display', 'sequence');
  await expect(contribution).toHaveAttribute('data-data-resolution', '1', { timeout: 20_000 });
  await expect(contribution).toHaveAttribute('data-sequence-render-mode', 'letters', { timeout: 20_000 });
  await expect(contribution.locator('.wb-plot-state')).toHaveText('DNA height');
  await expect(contribution).toHaveAttribute('data-scale-min', /-\d/);
  await expect(contribution).toHaveAttribute('data-scale-max', /[1-9]/);
  await expect(group).toContainText('4 shown · 100 available · hg38');
});
