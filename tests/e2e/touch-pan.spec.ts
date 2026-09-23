import { expect, test, type Page } from '@playwright/test';

// A finger on a phone. The viewport blocks native touch so it can own the
// gesture, but it only ever acted on two fingers: one finger did nothing at
// all, so a swipe along the genome went nowhere and the track list would not
// scroll either.

test.use({
  viewport: { width: 390, height: 664 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

async function viewStartBp(page: Page): Promise<number> {
  const text = (await page.locator('body').textContent()) ?? '';
  const match = text.match(/chr\w+:([\d,]+)-([\d,]+)/);
  if (!match) throw new Error('no locus readout');
  return Number(match[1]!.replace(/,/g, ''));
}

/** The view after the fling has run out: a release keeps moving under inertia. */
async function viewSpanBp(page: Page): Promise<number> {
  const text = (await page.locator('body').textContent()) ?? '';
  const match = text.match(/chr\w+:([\d,]+)-([\d,]+)/);
  if (!match) throw new Error('no locus readout');
  return Number(match[2]!.replace(/,/g, '')) - Number(match[1]!.replace(/,/g, ''));
}

async function settledStartBp(page: Page): Promise<number> {
  let previous = await viewStartBp(page);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(120);
    const current = await viewStartBp(page);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

async function swipe(page: Page, deltaX: number, deltaY: number): Promise<void> {
  const scene = page.locator('.browser-scene');
  const box = (await scene.boundingBox())!;
  await scene.evaluate(
    async (element, { x, y, dx, dy }) => {
      const fire = (type: string, clientX: number, clientY: number) => {
        element.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire('pointerdown', x, y);
      const steps = 12;
      for (let step = 1; step <= steps; step += 1) {
        // A real finger takes a couple of hundred milliseconds to cross the
        // screen. Firing every move in the same millisecond reads as a flick at
        // 10px/ms, and the fling that follows throws the view off the arm.
        await new Promise((resolve) => setTimeout(resolve, 16));
        fire('pointermove', x + (dx * step) / steps, y + (dy * step) / steps);
      }
      fire('pointerup', x + dx, y + dy);
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2, dx: deltaX, dy: deltaY },
  );
}

test('a horizontal swipe pans the genome; a vertical one leaves it alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  const opened = await settledStartBp(page);

  // Dragging the sequence to the left moves the view to higher coordinates.
  await swipe(page, -120, 0);
  await expect.poll(() => viewStartBp(page)).toBeGreaterThan(opened);
  const afterLeft = await settledStartBp(page);

  // And back the other way.
  await swipe(page, 140, 0);
  await expect.poll(() => viewStartBp(page)).toBeLessThan(afterLeft);
  const afterRight = await settledStartBp(page);

  // A finger going down the list is scrolling the list, not panning. (Not an
  // exact equality: settling the fling rounds the centre by a few base pairs,
  // against a swipe of this length being worth a megabase.)
  const span = await viewSpanBp(page);
  await swipe(page, 0, -160);
  await page.waitForTimeout(500);
  expect(Math.abs((await viewStartBp(page)) - afterRight)).toBeLessThan(span * 0.001);
});

test('the track list keeps the vertical axis for itself', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  // The browser scrolls the list (momentum, rubber banding); the scene around
  // it takes every touch so a swipe pans and two fingers pinch.
  await expect
    .poll(() => page.locator('.track-virtuoso').evaluate((el) => getComputedStyle(el).touchAction))
    .toBe('pan-y');
  await expect
    .poll(() => page.locator('.browser-scene').evaluate((el) => getComputedStyle(el).touchAction))
    .toBe('none');
});
