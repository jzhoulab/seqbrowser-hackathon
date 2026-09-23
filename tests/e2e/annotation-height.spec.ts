import { expect, test, type Page } from '@playwright/test';

// The annotation row can be grown. At its 96px default a gene-dense locus hides
// most of its transcripts behind "+N hidden"; the note grows the row to fit,
// the lower edge drags, and a row at its height cap scrolls its lanes under
// the wheel instead of growing further. Other rows are left alone: a signal
// track's height is a preference, an annotation row's is what is on screen.

const genes = (page: Page) => page.locator('.track-row').filter({ hasText: /GENCODE/ }).first();

async function openActb(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  const jump = page.locator('#jump');
  await jump.click();
  await jump.fill('chr7:5,527,148-5,530,601');
  await jump.press('Enter');
  const row = genes(page);
  await expect(row).toHaveAttribute('data-resizable', 'true');
  await expect(row).toHaveAttribute('data-height', '96');
  return row;
}

test('the hidden-count note grows the row to fit its lanes', async ({ page }) => {
  test.setTimeout(90_000);
  const row = await openActb(page);
  const canvas = row.locator('canvas');
  // The note exists once the transcripts have arrived and packed into more
  // lanes than the row draws: wait for the row to say so, not for a delay.
  await expect.poll(async () => (await canvas.getAttribute('data-lanes')) ?? '', { timeout: 45_000 }).toMatch(/^\d+:\d+:[1-9]\d*$/);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width - 40, box.y + 8);

  // Grown: taller than the default, and no taller than the cap.
  const height = await expect.poll(async () => Number(await row.getAttribute('data-height')), { timeout: 10_000 }).toBeGreaterThan(96).then(() => row.getAttribute('data-height'));
  const cap = await page.evaluate(() => Math.max(240, Math.round(window.innerHeight * 0.55)));
  expect(Number(height)).toBeLessThanOrEqual(cap);
  // The canvas followed the row.
  await expect.poll(async () => Math.round((await canvas.boundingBox())!.height)).toBe(Number(height));
});

test('the lower edge drags, within the floor and the cap', async ({ page }) => {
  const row = await openActb(page);
  const handle = row.getByRole('separator', { name: /Resize/ });
  const box = (await handle.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  await expect(row).toHaveAttribute('data-height', '216');

  // Dragging far past the top stops at the floor, not at zero.
  const box2 = (await handle.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, box2.y - 600, { steps: 6 });
  await page.mouse.up();
  await expect(row).toHaveAttribute('data-height', '40');
});

test('a row at its cap scrolls its lanes under the wheel instead of growing', async ({ page }) => {
  test.setTimeout(90_000);
  const row = await openActb(page);
  const canvas = row.locator('canvas');
  await expect.poll(async () => (await canvas.getAttribute('data-lanes')) ?? '', { timeout: 45_000 }).toMatch(/^\d+:\d+:[1-9]\d*$/);
  // ACTB needs 62 lanes: more than fit under the cap on any screen, so a
  // grown row still hides some and keeps a window onto them.
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width - 40, box.y + 8);
  await expect.poll(async () => Number(await row.getAttribute('data-height'))).toBeGreaterThan(96);
  const grown = Number(await row.getAttribute('data-height'));
  await expect.poll(async () => (await canvas.getAttribute('data-lanes')) ?? '').toMatch(/^62:\d+:[1-9]\d*$/);
  const [, drawn, hiddenBefore] = ((await canvas.getAttribute('data-lanes')) ?? '').split(':').map(Number);
  expect(drawn).toBeGreaterThan(8);

  // Wheel down over the row: the window moves and the height does not. The
  // hidden count is per transcript, not per lane, so it shifts by however many
  // more or fewer transcripts the lanes that scrolled in hold than the ones
  // that scrolled out; that it changed at all is the window having moved.
  const grownBox = (await canvas.boundingBox())!;
  const locusBefore = await page.locator('#jump').inputValue();
  await page.mouse.move(grownBox.x + grownBox.width / 2, grownBox.y + grownBox.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => ((await canvas.getAttribute('data-lanes')) ?? '').split(':')[2]).not.toBe(String(hiddenBefore));
  expect(Number(await row.getAttribute('data-height'))).toBe(grown);
  const [, drawnAfter] = ((await canvas.getAttribute('data-lanes')) ?? '').split(':').map(Number);
  expect(drawnAfter).toBe(drawn);
  // And the genome did not move: the wheel was taken by the lanes, not the view.
  expect(await page.locator('#jump').inputValue()).toBe(locusBefore);
});

test('a signal row has no handle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  const signal = page.locator('.track-row').filter({ hasText: /H3K27ac/ }).first();
  await expect(signal).toBeVisible();
  await expect(signal).not.toHaveAttribute('data-resizable', 'true');
  await expect(signal.getByRole('separator')).toHaveCount(0);
});
