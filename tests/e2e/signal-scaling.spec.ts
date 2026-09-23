import { openLibrary, openData } from './workspace';
import { expect, test, type Locator, type Page } from '@playwright/test';

const H3K27AC_URL =
  'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/wgEncodeReg/wgEncodeRegMarkH3k27ac/wgEncodeBroadHistoneGm12878H3k27acStdSig.bigWig';
const H3K4ME3_URL =
  'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/wgEncodeReg/wgEncodeRegMarkH3k4me3/wgEncodeBroadHistoneGm12878H3k4me3StdSig.bigWig';
const H3K27AC_NAME = 'wgEncodeBroadHistoneGm12878H3k27acStdSig.bigWig';
const H3K4ME3_NAME = 'wgEncodeBroadHistoneGm12878H3k4me3StdSig.bigWig';

function trackRow(page: Page, name: string): Locator {
  return page.locator('.track-row').filter({
    has: page.locator('.track-name', { hasText: new RegExp(`^${name}$`) }),
  });
}

async function addRemoteTrack(page: Page, url: string) {
  await openData(page);
  await page.getByLabel(/remote url or app-relative path/i).fill(url);
  await page.getByRole('button', { name: 'Add track', exact: true }).click();
}

async function effectiveDomain(row: Locator): Promise<[string | null, string | null]> {
  return Promise.all([
    row.getAttribute('data-scale-min'),
    row.getAttribute('data-scale-max'),
  ]);
}

test('ordinary BigWig tracks support linked, fixed, and restored auto scales', async ({ page }) => {
  // This is the one spec that needs real signal values rather than just chrome,
  // and the demo tracks stream from UCSC. The suite-wide 30s budget is not enough
  // once several specs have run and the browser is queueing range requests.
  test.setTimeout(90_000);
  await page.goto('/');
  await addRemoteTrack(page, H3K27AC_URL);
  await addRemoteTrack(page, H3K4ME3_URL);

  const h3k27ac = trackRow(page, H3K27AC_NAME);
  const h3k4me3 = trackRow(page, H3K4ME3_NAME);
  await expect(h3k27ac).toBeVisible();
  await expect(h3k4me3).toBeVisible();

  await openLibrary(page);
  const manager = page.getByLabel('Track manager rows');
  await expect(manager).toBeVisible();
  await manager.getByLabel(`Select ${H3K27AC_NAME}`, { exact: true }).check();
  await manager.getByLabel(`Select ${H3K4ME3_NAME}`, { exact: true }).check();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Shared scale', exact: true }).click();
  await expect(h3k27ac).toHaveAttribute('data-scale-mode', 'linked');
  await expect(h3k4me3).toHaveAttribute('data-scale-mode', 'linked');
  // The compact library rows carry no scale badge; the control reports the state
  // of the selection instead, and the rows themselves are checked above.
  await expect(page.getByRole('button', { name: 'Shared scale', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // The demo tracks stream from UCSC, so a track has no domain at all until its
  // first blocks land. Wait for data to exist before comparing domains, otherwise
  // a slow fetch is indistinguishable from a broken link and reports as the latter.
  await expect(h3k27ac).toHaveAttribute('data-scale-max', /\S/, { timeout: 45_000 });
  await expect(h3k4me3).toHaveAttribute('data-scale-max', /\S/, { timeout: 45_000 });

  await expect.poll(async () => {
    const [first, second] = await Promise.all([
      effectiveDomain(h3k27ac),
      effectiveDomain(h3k4me3),
    ]);
    return first[0] !== null && first[1] !== null &&
      first[0] === second[0] && first[1] === second[1];
  }, { timeout: 20_000 }).toBe(true);
  await expect(h3k27ac.locator('.track-scale-mode')).toHaveText(/^linked$/i);
  await expect(h3k4me3.locator('.track-scale-mode')).toHaveText(/^linked$/i);

  await page.getByRole('button', { name: 'Fixed limits', exact: true }).click();
  await page.getByLabel('Fixed scale minimum').fill('-2');
  await page.getByLabel('Fixed scale maximum').fill('8');
  await page.getByRole('button', { name: 'Apply limits', exact: true }).click();

  for (const row of [h3k27ac, h3k4me3]) {
    await expect(row).toHaveAttribute('data-scale-mode', 'fixed');
    await expect(row).toHaveAttribute('data-scale-min', '-2');
    await expect(row).toHaveAttribute('data-scale-max', '8');
    await expect(row.locator('.track-scale-labels > span').first()).toHaveText('8');
    await expect(row.locator('.track-scale-mode')).toHaveText(/^fixed$/i);
    await expect(row.locator('.track-scale-labels > span').last()).toHaveText('−2');
  }
  await expect(page.getByRole('button', { name: 'Fixed limits', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Auto each', exact: true }).click();
  await expect(h3k27ac).toHaveAttribute('data-scale-mode', 'auto');
  await expect(h3k4me3).toHaveAttribute('data-scale-mode', 'auto');
  await expect(h3k27ac.locator('.track-scale-mode')).toHaveText(/^auto$/i);
  await expect(h3k4me3.locator('.track-scale-mode')).toHaveText(/^auto$/i);
  await expect(page.getByRole('button', { name: 'Auto each', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
