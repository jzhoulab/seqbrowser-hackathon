import { toggleModels } from './workspace';
import { expect, test, type Page } from '@playwright/test';

// The layout on a phone. An iPhone gives the page 390x664 in portrait, and the
// header used to take 299 of those 664, which left two and a half track rows;
// in landscape it took 235 of 390 and left the tracks two pixels. These are the
// budgets that keep the genome the subject of the screen.

// An iPhone 14's own numbers, spelled out rather than taken from
// `devices['iPhone 14']`: that descriptor also carries defaultBrowserType
// 'webkit', which silently moved this file onto a browser the CI runner does
// not install, and the suite runs on Chromium.
test.use({
  viewport: { width: 390, height: 664 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

async function boxOf(page: Page, selector: string): Promise<{ width: number; height: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  }, selector);
}

async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    return Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > width + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''}`)
      .slice(0, 8);
  });
}

test('portrait: nothing overflows, the header stays out of the way, and fields are tappable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();

  expect(await overflowing(page)).toEqual([]);

  const header = await boxOf(page, '.hf-topbar');
  const viewport = await boxOf(page, '[role="application"]');
  expect(header!.height).toBeLessThan(200);
  // The browser is the point of the page: it gets more of the screen than
  // everything else put together.
  expect(viewport!.height).toBeGreaterThan(332);

  // Every field has to be a target for a finger. Type size is a separate rule
  // and applies to what you type into: iOS zooms the page in when a focused
  // TEXT field is under 16px and does not zoom back out. A select opens a
  // picker rather than a caret, so it can take the smaller type and leave the
  // width to the coordinate box, which is what you came to the phone to read.
  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.hf-locus input, .hf-locus select')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
      height: Math.round(el.getBoundingClientRect().height),
      width: Math.round(el.getBoundingClientRect().width),
    })),
  );
  expect(fields.length).toBeGreaterThan(1);
  for (const field of fields) {
    expect(field.height, field.tag).toBeGreaterThanOrEqual(32);
    if (field.tag === 'input') {
      expect(field.fontSize).toBeGreaterThanOrEqual(16);
    }
  }

  // The coordinate gets more of the row than either picker.
  const coordinate = fields.find((field) => field.tag === 'input')!;
  for (const picker of fields.filter((field) => field.tag === 'select')) {
    expect(coordinate.width).toBeGreaterThan(picker.width);
  }
});

test('portrait: the view controls collapse to a line that still reads them', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();

  // Collapsed by default: strand, zoom and bin cost a sixth of the screen, and
  // pinch and swipe reach the same zoom and pan.
  const summary = page.locator('.hf-transport-summary');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toContainText('strand');
  await expect(summary).toContainText('bp/px');
  await expect(page.locator('#zoom')).toBeHidden();

  const collapsed = (await boxOf(page, '[role="application"]'))!.height;
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#zoom')).toBeVisible();
  expect((await boxOf(page, '[role="application"]'))!.height).toBeLessThan(collapsed);

  await summary.click();
  await expect(page.locator('#zoom')).toBeHidden();
});

test('portrait: the gene suggestions stay on the screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();

  // Portalled to the body and placed at the input's left edge, which on a phone
  // is most of the way across the screen, the list used to hang off the side.
  await page.locator('#jump').click();
  await page.locator('#jump').fill('ACTB');
  const list = page.locator('.hf-locus-results');
  await expect(list).toBeVisible();

  const bounds = await list.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  });
  const screen = page.viewportSize()!;
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(screen.width);
  expect(bounds.width).toBeGreaterThan(200);
});

test('portrait: a panel takes the screen and closes from its own button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  await toggleModels(page);

  // A sheet that stopped short of the header covered the toggle that opened it.
  const panel = await boxOf(page, '.wb-tools-dialog[open]');
  const screen = page.viewportSize()!;
  expect(panel!.width).toBe(screen.width);
  expect(panel!.height).toBeGreaterThan(screen.height * 0.8);
  expect(panel!.height).toBeLessThanOrEqual(screen.height);

  await page.locator('.hf-models-panel__close').click();
  await expect(page.locator('.wb-tools-dialog[open]')).toHaveCount(0);
});

test('landscape: the header gives the tracks most of the height', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await boxOf(page, '.hf-topbar'))!.height).toBeLessThan(200);

  const viewport = await boxOf(page, '[role="application"]');
  expect(viewport!.height).toBeGreaterThan(120);
  expect(await overflowing(page)).toEqual([]);
  // The ideogram is an orientation aid; at this height it costs a quarter of
  // the tracks and the status bar names the locus anyway.
  expect(await boxOf(page, '.brush-wrap')).toEqual({ width: 0, height: 0 });
});
