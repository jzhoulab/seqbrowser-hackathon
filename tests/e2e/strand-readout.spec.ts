import { expect, test, type Page } from '@playwright/test';

// On the minus strand the strip reads that strand: the cells are reversed and
// each letter complemented. The hover readout reported the PLUS base at the same
// coordinate, so the strip drew T while its own tooltip said A, with nothing to
// say which was which. Reported by a collaborator as the sequence showing
// "the RC of the position".

type Cell = { start: number; letter: string; title: string };

async function cells(page: Page): Promise<Cell[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.sequence-base[data-start]'))
      .slice(0, 10)
      .map((el) => ({
        start: Number(el.getAttribute('data-start')),
        letter: (el.textContent ?? '').trim(),
        title: el.getAttribute('title') ?? '',
      })),
  );
}

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };

test('the sequence readout names the letter it draws, and says which strand', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  const jump = page.locator('#jump');
  await jump.click();
  await jump.fill('chr5:70,951,900-70,952,000');
  await jump.press('Enter');
  await expect(page.locator('.sequence-base[data-start]').first()).toBeVisible();

  const plus = await cells(page);
  expect(plus.length).toBeGreaterThan(4);
  for (const cell of plus) {
    // `data-start` is internal (0-based); a reader sees 1-based, as UCSC prints.
    const shown = (cell.start + 1).toLocaleString('en-US');
    expect(cell.title, `${cell.start}`).toBe(`chr5:${shown} ${cell.letter}`);
  }

  await page.getByRole('button', { name: /Reading the plus strand/ }).click();
  await expect.poll(async () => (await cells(page))[0]?.start).not.toBe(plus[0]!.start);

  const minus = await cells(page);
  const plusByStart = new Map(plus.map((cell) => [cell.start, cell.letter]));
  for (const cell of minus) {
    // The readout carries the letter on screen, its strand, and the plus base.
    expect(cell.title, `${cell.start}`).toContain(`${cell.letter} on the − strand`);
    expect(cell.title, `${cell.start}`).toMatch(/· [ACGTN] on \+$/);

    const plusLetter = plusByStart.get(cell.start);
    if (plusLetter) {
      // And the glyph really is the other strand's base at that coordinate.
      expect(cell.letter, `${cell.start}`).toBe(COMPLEMENT[plusLetter]);
      expect(cell.title).toContain(`${plusLetter} on +`);
    }
  }
});

test('a coordinate pasted from UCSC lands on the base UCSC says it is', async ({ page }) => {
  // hg38 chr5:70,951,892 is a T, and chr5:70,951,951 an A (checked against
  // api.genome.ucsc.edu, which answers in 0-based half-open and was read back
  // as 1-based). The browser displayed the internal 0-based number, so both
  // used to sit one base to the left of where they belong.
  await page.goto('/');
  await expect(page.getByLabel('Chr')).toBeVisible();
  const jump = page.locator('#jump');
  await jump.click();
  await jump.fill('chr5:70,951,880-70,951,960');
  await jump.press('Enter');
  await expect(page.locator('.sequence-base[data-start]').first()).toBeVisible();

  for (const [position, base] of [['70,951,892', 'T'], ['70,951,951', 'A']] as const) {
    const cell = page.locator(`.sequence-base[title^="chr5:${position} "]`);
    await expect(cell, position).toHaveCount(1);
    await expect(cell, position).toHaveText(base);
  }
});
