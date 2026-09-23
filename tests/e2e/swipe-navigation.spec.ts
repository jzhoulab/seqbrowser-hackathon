import { expect, test } from '@playwright/test';

// A two-finger horizontal swipe pans the genome. macOS browsers otherwise claim that
// gesture for history back/forward, so a pan would navigate away mid-drag.
//
// preventDefault on the wheel event is not enough on its own: the history gesture is
// decided at the viewport, which takes overscroll-behavior from html/body, and a swipe
// can start over chrome that the wheel handler does not cover.

test('the viewport refuses overscroll, so a swipe cannot become browser history', async ({ page }) => {
  await page.goto('/');

  const behavior = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overscrollBehaviorX,
    body: getComputedStyle(document.body).overscrollBehaviorX,
  }));

  expect(behavior.html).toBe('none');
  expect(behavior.body).toBe('none');
});

test('a horizontal wheel over the tracks is consumed for panning', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.track-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  if (!box) throw new Error('expected a track row');

  const consumed = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    const event = new WheelEvent('wheel', {
      deltaX: 42, deltaY: 1, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { x: box.x + Math.min(500, box.width - 20), y: box.y + 30 });

  expect(consumed).toBe(true);
});
