import { expect, test, type Page } from '@playwright/test';

// A trackpad pinch reaches the page as gesture events in Safari only: Chromium
// and Firefox synthesize a ctrl-key wheel instead and expose no gesture events
// at all. The viewport used to take the default away from those events without
// zooming, so pinch-to-zoom did nothing in Safari while working in Chrome.
// Synthetic events drive that path in whatever browser the suite runs.

async function spanBp(page: Page): Promise<number> {
  const text = (await page.locator('body').textContent()) ?? '';
  const match = text.match(/chr\w+:([\d,]+)-([\d,]+)/);
  if (!match) throw new Error('no locus readout');
  return Number(match[2]!.replace(/,/g, '')) - Number(match[1]!.replace(/,/g, ''));
}

async function pinch(page: Page, scales: number[]): Promise<void> {
  const host = page.getByRole('application', { name: 'Genome browser viewport' });
  const box = (await host.boundingBox())!;
  await host.evaluate(
    (element, { x, y, steps }) => {
      const fire = (type: string, scale: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
          scale: number;
          clientX: number;
          clientY: number;
        };
        event.scale = scale;
        event.clientX = x;
        event.clientY = y;
        element.dispatchEvent(event);
      };
      fire('gesturestart', 1);
      for (const scale of steps) fire('gesturechange', scale);
      fire('gestureend', steps[steps.length - 1] ?? 1);
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2, steps: scales },
  );
}

test('a trackpad pinch zooms the view, in and out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  const opened = await spanBp(page);

  await pinch(page, [1.1, 1.2, 1.35, 1.5]);
  await expect.poll(() => spanBp(page)).toBeLessThan(opened * 0.75);
  const zoomedIn = await spanBp(page);

  await pinch(page, [0.9, 0.8, 0.7, 0.6]);
  await expect.poll(() => spanBp(page)).toBeGreaterThan(zoomedIn * 1.3);
});
