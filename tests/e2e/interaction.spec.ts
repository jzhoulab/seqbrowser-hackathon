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

async function readVisibleRangeText(page: Page) {
  return (await page.locator('footer.statusbar span').first().innerText()).trim();
}

async function readVisibleRange(page: Page) {
  const rangeText = await readVisibleRangeText(page);
  return parseVisibleRange(rangeText);
}

function span(range: VisibleRange) {
  return range.end - range.start;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await expect(viewport).toBeVisible();
  await viewport.focus();
});

test('keyboard pan shortcut shifts the visible genomic range', async ({ page }) => {
  const before = await readVisibleRange(page);

  await page.keyboard.press('ArrowRight');

  await expect
    .poll(async () => {
      const next = await readVisibleRange(page);
      return next.start;
    })
    .toBeGreaterThan(before.start);
});

test('keyboard zoom shortcuts adjust visible span', async ({ page }) => {
  const before = await readVisibleRange(page);

  await page.keyboard.press('=');

  await expect
    .poll(async () => {
      const next = await readVisibleRange(page);
      return span(next);
    })
    .toBeLessThan(span(before));

  const zoomedIn = await readVisibleRange(page);
  await page.keyboard.press('-');

  await expect
    .poll(async () => {
      const next = await readVisibleRange(page);
      return span(next);
    })
    .toBeGreaterThan(span(zoomedIn));
});

test('touchpad two-finger scroll scrolls tracks instead of zooming', async ({ page }) => {
  await page.goto('/?preset=stress');
  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await expect(viewport).toBeVisible();
  await viewport.focus();
  await viewport.hover();
  const before = await readVisibleRange(page);

  // Touchpad glides arrive as fractional pixel deltas; Playwright's mouse.wheel()
  // always looks like a physical wheel, so dispatch the real shape directly.
  const scrolled = await page.evaluate(async () => {
    const scene = document.querySelector('.browser-scene') as HTMLElement | null;
    const scroller = document.querySelector('.track-virtuoso') as HTMLElement | null;
    if (!scene || !scroller) {
      return null;
    }
    const startTop = scroller.scrollTop;
    for (let i = 0; i < 12; i += 1) {
      scene.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 0, deltaY: 24.5, deltaMode: 0, bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { startTop, endTop: scroller.scrollTop };
  });

  expect(scrolled).not.toBeNull();
  expect(scrolled!.endTop).toBeGreaterThan(scrolled!.startTop);

  // The genomic range must be untouched — this gesture is scroll, not zoom.
  const after = await readVisibleRange(page);
  expect(span(after)).toBe(span(before));
});

test('mouse wheel zooms the genome view', async ({ page }) => {
  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.hover();
  const before = await readVisibleRange(page);

  // Wheel up = zoom in (span shrinks).
  await page.mouse.wheel(0, -600);
  await expect
    .poll(async () => span(await readVisibleRange(page)))
    .toBeLessThan(span(before));

  const zoomedIn = await readVisibleRange(page);

  // Wheel down = zoom out (span grows).
  await page.mouse.wheel(0, 600);
  await expect
    .poll(async () => span(await readVisibleRange(page)))
    .toBeGreaterThan(span(zoomedIn));
});
