import { expect, type Page, type Locator } from '@playwright/test';

/** Navigate the candidate's desktop docks and mobile modal sheets. */
export async function closeWorkspaceTools(page: Page) {
  const close = page.locator('dialog[open][role="dialog"], .wb-tools-dialog[open]').getByRole('button', { name: /^(Close sequence models|Close Data sources|Close tracks|Close properties)$/ }).filter({ visible: true });
  if (await close.count()) await close.click();
}

export async function openModels(page: Page) {
  if (await page.getByRole('dialog', { name: 'Models', exact: true }).isVisible()) return;
  await closeWorkspaceTools(page);
  const desktop = page.getByRole('navigation', { name: 'Browser tools' });
  const navigation = await desktop.isVisible() ? desktop : page.getByRole('navigation', { name: 'Workspace tools' });
  await navigation.getByRole('button', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Models', exact: true })).toBeVisible();
}

export async function toggleModels(page: Page) {
  if (await page.getByRole('dialog', { name: 'Models', exact: true }).isVisible()) await closeWorkspaceTools(page);
  else await openModels(page);
}

export async function openData(page: Page) {
  if (await page.getByRole('dialog', { name: 'Data sources', exact: true }).isVisible()) return;
  await closeWorkspaceTools(page);
  const desktop = page.getByRole('navigation', { name: 'Browser tools' });
  const navigation = await desktop.isVisible() ? desktop : page.getByRole('navigation', { name: 'Workspace tools' });
  await navigation.getByRole('button', { name: 'Data', exact: true }).click();
}

export async function openLibrary(page: Page) {
  await closeWorkspaceTools(page);
  if (!(await page.getByRole('region', { name: 'Tracks', exact: true }).isVisible())) {
    await page.getByRole('button', { name: /^Tracks(?: \d+)?$/ }).click();
  }
  await expect(page.getByLabel('Track manager rows')).toBeVisible();
}

/** Select the real plot, then reveal its secondary arrangement controls. */
export async function inspectPlot(page: Page, plot: Locator) {
  await plot.getByRole('button', { name: /^Inspect / }).click();
  return page.getByRole('region', { name: 'Properties', exact: true });
}

export async function openArrangement(page: Page) {
  const arrangement = page.locator('.wb-arrangement');
  if (await arrangement.getAttribute('open') === null) await arrangement.locator('summary').click();
}
