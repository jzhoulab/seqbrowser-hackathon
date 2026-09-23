import { expect, test, type Page } from '@playwright/test';

// Reading the minus strand mirrors the view. A drag or a horizontal wheel must
// still move what is under the pointer in the direction of the gesture, which in
// genomic coordinates is the opposite of the plus strand. The mouse drag has its
// own path into the viewport (it sets the centre directly), and it once kept the
// plus-strand direction while the wheel flipped.

const AT_ACTB = Buffer.from(
  JSON.stringify({
    v: 1,
    state: {
      assemblyId: 'hg38', chr: 'chr7', search: '', binScale: 0.5, activePanel: 'none',
      navigatorTrackId: '__ideogram__', centerBp: 5_528_200, bpPerPx: 2,
    },
  }),
).toString('base64url');

async function centreBp(page: Page): Promise<number> {
  const text = (await page.locator('body').textContent()) ?? '';
  const match = text.match(/chr7:([\d,]+)-([\d,]+)/);
  if (!match) throw new Error('no locus readout');
  return (Number(match[1]!.replace(/,/g, '')) + Number(match[2]!.replace(/,/g, ''))) / 2;
}

async function dragRight(page: Page): Promise<void> {
  const box = await page.locator('.track-row').first().locator('canvas').boundingBox();
  if (!box) throw new Error('no track canvas');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 300, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(box.x + 300 + step * 20, y);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
}

test('a drag and a wheel move the view with the gesture on both strands', async ({ page }) => {
  await page.goto(`/?state=${AT_ACTB}`);
  await expect(page.locator('.track-row').first()).toBeVisible({ timeout: 30_000 });

  // Plus strand: dragging the content to the right shows lower coordinates.
  const plusBefore = await centreBp(page);
  await dragRight(page);
  const plusAfterDrag = await centreBp(page);
  expect(plusAfterDrag).toBeLessThan(plusBefore - 100);

  // Minus strand: the view is mirrored, so the same drag shows higher coordinates.
  await page.getByRole('button', { name: 'Reading the plus strand; switch to minus' }).click();
  const minusBefore = await centreBp(page);
  await dragRight(page);
  const minusAfterDrag = await centreBp(page);
  expect(minusAfterDrag).toBeGreaterThan(minusBefore + 100);

  // And the wheel agrees with the drag on the mirrored view.
  const box = await page.locator('.track-row').first().locator('canvas').boundingBox();
  await page.mouse.move(box!.x + 600, box!.y + box!.height / 2);
  await page.mouse.wheel(300, 0);
  await page.waitForTimeout(800);
  expect(await centreBp(page)).toBeLessThan(minusAfterDrag - 100);
});
