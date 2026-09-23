import { expect, test, type Page } from '@playwright/test';

// The editing model: the pinned sequence row is the one you edit -- a text field
// over the genome. With edits it becomes the edited sequence and the original
// appears beneath as a reference track. No menu of edit kinds; and a strand
// flip reverse-complements the whole browser.

const AT_ACTB = Buffer.from(
  JSON.stringify({
    v: 1,
    state: {
      assemblyId: 'hg38', chr: 'chr7', search: '', binScale: 0.5, activePanel: 'none',
      navigatorTrackId: '__ideogram__', centerBp: 5_528_200, bpPerPx: 0.12,
    },
  }),
).toString('base64url');

async function openAtBaseResolution(page: Page) {
  await page.goto(`/?state=${AT_ACTB}`);
  await expect(page.locator('[data-layer="reference"][data-start]').first()).toBeVisible({ timeout: 30_000 });
}


test('editing the pinned sequence makes it the edited sequence, with the reference beneath', async ({ page }) => {
  test.setTimeout(60_000);
  await openAtBaseResolution(page);
  const pinnedTitle = page.locator('.sequence-strips .sequence-strip-title');
  const referenceRows = page.locator('.sequence-reference-track');

  await expect(pinnedTitle).toHaveText('Sequence');
  await expect(referenceRows).toHaveCount(0);

  // Click a base in the pinned row and type: the row you edit IS the sequence.
  const cell = page.locator('.sequence-strips [data-layer="reference"][data-start]').nth(40);
  const box = await cell.boundingBox();
  if (!box) throw new Error('expected a base cell');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.keyboard.type('GG');

  await expect(pinnedTitle).toHaveText('Edited sequence');
  await expect(referenceRows).toHaveCount(1);

  // The list splits into sections marked by the two sequence rows: the pinned
  // edited row wears the edit colour, as do the outputs re-run on the edit
  // beneath it; the reference strip opens everything scored on the reference.
  await expect(page.locator('.sequence-strips[data-section="edited"]')).toHaveCount(1);
  await expect(page.locator('.sequence-reference-track[data-section="reference"]')).toHaveCount(1);
  await expect(page.locator('.sequence-reference-track .sequence-strip-title')).toHaveText('Reference sequence');
  const editedRows = page.locator('.track-row[data-section="edited"]');
  const mirrored = await editedRows.count();
  if (mirrored > 0) {
    // Every model output on the reference is mirrored; HIDE stops one, and the
    // edited sequence row offers it back.
    await editedRows.first().getByRole('button', { name: /on the edited sequence/ }).click();
    await expect(editedRows).toHaveCount(mirrored - 1);
    const restore = page.locator('.sequence-strips .sequence-strip-restore');
    await expect(restore).toHaveText('Show 1 hidden output');
    await restore.click();
    await expect(editedRows).toHaveCount(mirrored);
    await expect(restore).toHaveCount(0);
  }

  // A second edit joins the same sequence; still one reference.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('A');
  await expect(referenceRows).toHaveCount(1);

  // Reset returns to the reference alone.
  await page.locator('.sequence-strips .sequence-strip-reset').click();
  await expect(pinnedTitle).toHaveText('Sequence');
  await expect(referenceRows).toHaveCount(0);
  await expect(page.locator('.sequence-strips[data-section="edited"]')).toHaveCount(0);
});

test('selecting a base opens no menu; the keys are the affordance', async ({ page }) => {
  await openAtBaseResolution(page);
  const cell = page.locator('[data-layer="reference"][data-start]').nth(50);
  await cell.click({ button: 'right' });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(page.getByText('Insert before')).toHaveCount(0);
});

test('the strand flip reverse-complements the browser, ruler included', async ({ page }) => {
  await openAtBaseResolution(page);
  const cells = page.locator('[data-layer="reference"][data-start]');
  const before = await cells.evaluateAll((nodes) => ({
    letters: nodes.map((n) => n.textContent?.trim()).join(''),
    starts: nodes.map((n) => Number(n.getAttribute('data-start'))),
  }));

  await page.locator('.hf-strand-btn').click();
  await expect(page.locator('.hf-strand-btn')).toHaveAttribute('aria-pressed', 'true');

  const after = await cells.evaluateAll((nodes) => ({
    letters: nodes.map((n) => n.textContent?.trim()).join(''),
    starts: nodes.map((n) => Number(n.getAttribute('data-start'))),
  }));
  const pairs: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C', N: 'N' };
  const reverseComplement = before.letters.split('').reverse().map((b) => pairs[b] ?? b).join('');

  // Reverse-complemented, not complemented in place.
  expect(after.letters).toBe(reverseComplement);
  // Coordinates now run right-to-left; every cell keeps its own.
  expect(after.starts[0]).toBe(before.starts[before.starts.length - 1]);
  expect(after.starts[after.starts.length - 1]).toBe(before.starts[0]);
});

test('on the minus strand, typing and deleting follow the screen, not the coordinates', async ({ page }) => {
  test.setTimeout(60_000);
  await openAtBaseResolution(page);
  await page.getByRole('button', { name: 'Reading the plus strand; switch to minus' }).click();
  await expect(page.locator('.sequence-strips [data-layer="reference"][data-start]').first()).toBeVisible();

  // Click a base and type T then G, as read on the minus strand.
  const cell = page.locator('.sequence-strips [data-layer="reference"][data-start]').nth(40);
  const box = await cell.boundingBox();
  if (!box) throw new Error('expected a base cell');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.keyboard.type('TG');

  // The run reads T then G left to right on the screen ...
  const inserted = page.locator('.sequence-strips [data-layer="insertion"]');
  await expect(inserted).toHaveCount(2);
  await expect(inserted).toHaveText(['T', 'G']);

  // ... and Backspace takes back the G, the last one typed.
  await page.keyboard.press('Backspace');
  await expect(inserted).toHaveCount(1);
  await expect(inserted).toHaveText(['T']);
});
