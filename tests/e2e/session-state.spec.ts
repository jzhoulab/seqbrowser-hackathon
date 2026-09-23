import { toggleModels } from './workspace';
import { expect, test, type Page } from '@playwright/test';

type VisibleRange = {
  start: number;
  end: number;
};

const RANGE_TEXT_RE = /^[^:]+:([\d,]+)-([\d,]+)$/;

function parseVisibleRange(text: string): VisibleRange {
  const match = text.match(RANGE_TEXT_RE);
  if (!match) {
    throw new Error(`Unexpected range label: ${text}`);
  }

  return {
    start: Number(match[1].replaceAll(',', '')),
    end: Number(match[2].replaceAll(',', '')),
  };
}

async function readVisibleRange(page: Page): Promise<VisibleRange> {
  const text = (await page.locator('footer.statusbar span').first().innerText()).trim();
  return parseVisibleRange(text);
}

type SessionEnvelope = {
  v: number;
  state: Record<string, unknown>;
};

function decodeSessionState(encoded: string): SessionEnvelope {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as SessionEnvelope;
}

test('state string restores viewport and panel/search state', async ({ page }) => {
  await page.goto('/');

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await expect(viewport).toBeVisible();
  await viewport.focus();

  await page.keyboard.press('=');
  await page.keyboard.press('ArrowRight');

  // The plot filter; a search input, named for what it filters.
  await page.getByRole('searchbox', { name: 'Filter plotted tracks' }).fill('cCRE');
  await toggleModels(page);

  const expectedRange = await readVisibleRange(page);
  const expectedCenter = Math.round((expectedRange.start + expectedRange.end) / 2);

  await expect
    .poll(async () => {
      const encoded = await page.evaluate(() => new URL(window.location.href).searchParams.get('state'));
      if (!encoded) {
        return false;
      }

      const decoded = decodeSessionState(encoded);
      return (
        decoded.state.activePanel === 'models' &&
        decoded.state.search === 'cCRE' &&
        typeof decoded.state.centerBp === 'number' &&
        Math.abs(decoded.state.centerBp - expectedCenter) <= 1 &&
        typeof decoded.state.bpPerPx === 'number' &&
        decoded.state.bpPerPx < 18_000
      );
    })
    .toBe(true);

  const encoded = await page.evaluate(() => new URL(window.location.href).searchParams.get('state'));
  if (!encoded) {
    throw new Error('Expected state query parameter to be present after sync.');
  }
  await page.goto(`/?state=${encoded}`);

  await expect(page.getByRole('searchbox', { name: 'Filter plotted tracks' })).toHaveValue('cCRE');
  await expect(page.getByRole('dialog', { name: 'Models', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sequence models' })).toBeVisible();

  await expect
    .poll(async () => {
      const restored = await readVisibleRange(page);
      return `${restored.start}:${restored.end}`;
    })
    .toBe(`${expectedRange.start}:${expectedRange.end}`);
});

test('the strand rides in the state string and survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Reading the plus strand; switch to minus' }).click();

  await expect
    .poll(async () => {
      const encoded = await page.evaluate(() => new URL(window.location.href).searchParams.get('state'));
      return encoded ? decodeSessionState(encoded).state.strand ?? null : null;
    })
    .toBe('-');

  const encoded = await page.evaluate(() => new URL(window.location.href).searchParams.get('state'));
  await page.goto(`/?state=${encoded}`);
  await expect(page.getByRole('button', { name: 'Reading the minus strand; switch to plus' })).toBeVisible();
});
