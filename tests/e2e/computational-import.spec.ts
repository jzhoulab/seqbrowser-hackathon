import { openModels } from './workspace';
import { expect, test, type Page } from '@playwright/test';

type CatalogModel = {
  id: 'seqbro2-puffin' | 'vibe-motifmatch';
  name: 'Puffin' | 'MotifMatch';
};

const PUFFIN: CatalogModel = { id: 'seqbro2-puffin', name: 'Puffin' };
const MOTIF_MATCH: CatalogModel = { id: 'vibe-motifmatch', name: 'MotifMatch' };

async function addCatalogModel(page: Page, model: CatalogModel) {
  await openModels(page);

  const library = page.getByRole('region', { name: 'Sequence models' });
  const modelCard = library.locator(`[data-model-id="${model.id}"]`);
  await expect(modelCard).toBeVisible();
  await expect(modelCard.getByRole('heading', { name: model.name })).toBeVisible();
  await modelCard.getByRole('button', { name: 'Run at current locus' }).click();

  // Catalog actions prepare the runtime before mounting their tracks. The model
  // group is the stable, non-virtualized signal that preparation and mounting
  // both completed successfully. The first model of a run also fetches the WASM
  // runtime, which on a cold CI runner is well over the default expect timeout.
  await expect(page.locator(`.hf-model-group[data-model-id="${model.id}"]`)).toBeVisible({ timeout: 60_000 });
}

test('adds catalog sequence models and exposes their outputs via search', async ({ page }) => {
  await page.goto('/');
  await addCatalogModel(page, PUFFIN);
  await addCatalogModel(page, MOTIF_MATCH);

  const searchInput = page.getByRole('searchbox', { name: 'Filter plotted tracks' });

  await searchInput.fill('Puffin');
  const puffinRows = page.locator('.track-row[data-model-id="seqbro2-puffin"]');
  await expect(puffinRows).toHaveCount(2);
  await expect(page.locator('.track-row[data-output-ids*="puffin-pred-plus"] .track-name')).toHaveText('Prediction');

  await searchInput.fill('MotifMatch');
  const motifRows = page.locator('.track-row[data-model-id="vibe-motifmatch"]');
  await expect(motifRows).toHaveCount(3);
  await expect(page.locator('.track-row[data-output-id="human-celltype-1"] .track-name')).toHaveText('Human activity 1');
});

test('catalog model outputs mount as new top rows', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.track-name').first()).toHaveText(/GENCODE V50/);
  await addCatalogModel(page, PUFFIN);

  const topRows = page.locator('.track-row');
  await expect(topRows.nth(0)).toHaveAttribute('data-output-ids', 'puffin-pred-plus puffin-pred-minus');
  await expect(topRows.nth(0).locator('.track-name')).toHaveText('Prediction');
  await expect(topRows.nth(1)).toHaveAttribute('data-output-id', 'puffin-effects-total');
  await expect(topRows.nth(1).locator('.track-name')).toHaveText('Total sequence effect');
});

test('computational packs run inference and produce features', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const packMod = await import('/src/data/computationalPack.ts');
    const dsMod = await import('/src/data/computationalDataSource.ts');
    const specMod = await import('/src/lib/trackWindowSpec.ts');
    const loaderMod = await import('/src/data/trackDataLoader.ts');

    async function run(packUrl: string) {
      const pack = await packMod.loadComputationalPack(packUrl);
      const track = {
        id: 'playwright-comp',
        name: 'playwright-comp',
        kind: 'signal' as const,
        color: '#000',
        height: 76,
        source: {
          type: 'computational' as const,
          packUrl,
          pack,
          subtrack: pack.subtracks[0],
        },
      };

      const viewport = {
        chr: 'chr1',
        chrLength: 248_956_422,
        widthPx: 1000,
        centerBp: 124_040_000,
        bpPerPx: 20,
        range: { start: 124_030_000, end: 124_050_000, span: 20_000 },
      };

      const base = loaderMod.deriveWindowSpec(
        viewport.chr,
        viewport.chrLength,
        viewport.centerBp,
        viewport.bpPerPx,
        viewport.widthPx,
        0.5,
      );
      const trackSpec = specMod.deriveTrackWindowSpec(track, viewport, base);
      try {
        const features = await dsMod.fetchComputationalTrackWindow(track.source, viewport.chr, trackSpec);
        return {
          ok: true,
          packId: pack.id,
          featureCount: features.length,
          requestSpanBp: trackSpec.requestEnd - trackSpec.requestStart,
        };
      } catch (error) {
        return {
          ok: false,
          packId: pack.id,
          error: error instanceof Error ? error.message : String(error),
          requestSpanBp: trackSpec.requestEnd - trackSpec.requestStart,
        };
      }
    }

    return {
      puffin: await run('/computational/packs/seqbro2-puffin.czpack'),
      vibe: await run('/computational/packs/vibe-motifmatch.czpack'),
    };
  });

  expect(result.puffin.ok).toBe(true);
  expect(result.vibe.ok).toBe(true);
  expect(result.puffin.featureCount).toBeGreaterThan(0);
  expect(result.vibe.featureCount).toBeGreaterThan(0);
});

test('under computational load, panning degrades smoothly and sequence still loads at base zoom', async ({ page }) => {
  await page.goto('/');
  await addCatalogModel(page, PUFFIN);
  await addCatalogModel(page, MOTIF_MATCH);

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.focus();

  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('=');
  }

  await expect
    .poll(
      async () => {
        return page.locator('.sequence-strip-window').innerText();
      },
      { timeout: 15_000 },
    )
    .not.toContain('zoom in to');

  await expect
    .poll(
      async () => {
        return (await page.locator('.sequence-strip-seq').innerText()).replace(/\s+/g, '');
      },
      { timeout: 15_000 },
    )
    .toMatch(/[ACGTN]{40,}/);

  const starts: number[] = [];
  const parseStart = (text: string) => {
    const match = text.trim().match(/^[^:]+:([\d,]+)-([\d,]+)$/);
    if (!match) {
      return 0;
    }
    return Number(match[1].replaceAll(',', ''));
  };

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('ArrowRight');
    const rangeText = await page.locator('footer.statusbar span').first().innerText();
    starts.push(parseStart(rangeText));
  }

  const distinctStarts = Array.from(new Set(starts));
  expect(distinctStarts.length).toBeGreaterThanOrEqual(5);
  expect(starts[starts.length - 1]).toBeGreaterThan(starts[0]);
});

test('computing buffer indicator clears after load catches up', async ({ page }) => {
  await page.goto('/');
  await addCatalogModel(page, PUFFIN);
  await addCatalogModel(page, MOTIF_MATCH);

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.focus();

  for (let index = 0; index < 35; index += 1) {
    await page.keyboard.press('=');
  }

  // The indicator appears only once a load has lingered (600 ms) and clears
  // the moment it catches up. On a fast machine the load can finish inside the
  // threshold and the indicator, correctly, never shows; so the first wait is
  // for the indicator OR for every model to have settled, whichever comes
  // first, and the invariant under test is that it does not linger afterwards.
  const busyModels = page.locator('.hf-model-group[data-state="computing"], .hf-model-group[data-state="preparing"]');
  await expect
    .poll(
      async () => (await page.locator('.hf-scroll-indicator').count()) > 0 || (await busyModels.count()) === 0,
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect
    .poll(
      async () => {
        return page.locator('.hf-scroll-indicator').count();
      },
      { timeout: 60_000 },
    )
    .toBe(0);
});

test('zooming in keeps computational buffer window stable', async ({ page }) => {
  await page.goto('/?debug=1');
  await addCatalogModel(page, PUFFIN);

  await page.getByRole('button', { name: 'Zoom to base resolution' }).click();
  await expect(page.locator('.hf-compute-debug')).toBeVisible();

  const firstRowRange = page.locator('.hf-compute-debug-row').first().locator('.hf-compute-debug-row-meta').first();
  await expect(firstRowRange).toContainText('chr1:');
  const beforeRange = await firstRowRange.innerText();

  const viewport = page.getByRole('application', { name: 'Genome browser viewport' });
  await viewport.focus();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('=');
    await page.waitForTimeout(110);
  }

  const afterRange = await firstRowRange.innerText();
  expect(beforeRange).toContain('chr1:');
  expect(afterRange).toContain('chr1:');
  const slotSummary = page.locator('.hf-compute-debug-row').first().locator('.hf-compute-debug-row-meta').last();
  // A CI runner computes the window several times slower than a laptop; the
  // point is that it settles, not how fast.
  await expect(slotSummary).toContainText('C:ready', { timeout: 30_000 });
  await expect(slotSummary).not.toContainText('C:loading');
  await expect(page.locator('.hf-scroll-indicator')).toHaveCount(0, { timeout: 30_000 });
});

test('inference window is capped to the latency budget', async ({ page }) => {
  await page.goto('/?debug=1');
  await addCatalogModel(page, PUFFIN);

  // Warm-up measures the model's cost on this device; the budget HUD then reports
  // the enforced window as calibrated rather than the conservative pre-warm default.
  const budget = page.locator('.hf-compute-debug-budget[data-pack="seqbro2-puffin"]');
  await expect(budget).toHaveAttribute('data-calibrated', 'true', { timeout: 15_000 });

  const budgetText = await budget.locator('.hf-compute-debug-budget-window').innerText();
  const capMatch = budgetText.match(/<= ([\d,]+) bp \/ (\d+)ms/);
  const capBp = Number((capMatch?.[1] ?? '0').replaceAll(',', ''));
  const budgetMs = Number(capMatch?.[2] ?? '0');

  expect(budgetMs).toBe(1_000);
  // Puffin declares an 86kb window, which is many seconds of inference. The budget
  // must shrink it to something the device can compute within ~1s, and it must not
  // collapse to the tiny pre-calibration floor.
  expect(capBp).toBeGreaterThan(512);
  expect(capBp).toBeLessThan(86_000);

  // The cap still permits real work: at sequence level the centre window computes.
  await page.getByRole('button', { name: 'Zoom to base resolution' }).click();
  const slotSummary = page.locator('.hf-compute-debug-row').first().locator('.hf-compute-debug-row-meta').last();
  await expect(slotSummary).toContainText('C:ready', { timeout: 10_000 });
});

test('zoom-to-sequence button activates sequence and computational inference level', async ({ page }) => {
  await page.goto('/');
  await addCatalogModel(page, PUFFIN);
  await addCatalogModel(page, MOTIF_MATCH);

  const zoomToSequenceButton = page.getByRole('button', { name: 'Zoom to base resolution' });
  await zoomToSequenceButton.click();

  await expect
    .poll(
      async () => {
        return (await page.locator('.sequence-strip-seq').innerText()).replace(/\s+/g, '');
      },
      { timeout: 15_000 },
    )
    .toMatch(/[ACGTN]{40,}/);

  await expect(zoomToSequenceButton).toBeDisabled();
  await expect(page.getByText(/Zoom in to <= .* bp window/)).toHaveCount(0);

  const parseRange = (text: string) => {
    const match = text.trim().match(/^[^:]+:([\d,]+)-([\d,]+)/);
    if (!match) {
      return null;
    }
    return {
      start: Number(match[1].replaceAll(',', '')),
      end: Number(match[2].replaceAll(',', '')),
    };
  };

  const trackRangeText = await page.locator('footer.statusbar span').first().innerText();
  const sequenceWindowText = await page.locator('.sequence-strip-window').innerText();
  const trackRange = parseRange(trackRangeText);
  const sequenceRange = parseRange(sequenceWindowText);
  expect(trackRange).not.toBeNull();
  expect(sequenceRange).not.toBeNull();
  const trackSpan = (trackRange?.end ?? 0) - (trackRange?.start ?? 0);
  const sequenceSpan = (sequenceRange?.end ?? 0) - (sequenceRange?.start ?? 0);
  expect(Math.abs(trackSpan - sequenceSpan)).toBeLessThanOrEqual(2);

  // Shared URLs are intentionally debounced; wait until they reflect the zoom
  // before using the encoded state to exercise the low-level inference path.
  await expect.poll(async () => {
    return page.evaluate(() => {
      const encoded = new URL(window.location.href).searchParams.get('state');
      if (!encoded) {
        return Number.POSITIVE_INFINITY;
      }
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const decoded = JSON.parse(atob(padded)) as { state?: { bpPerPx?: unknown } };
      return typeof decoded.state?.bpPerPx === 'number'
        ? decoded.state.bpPerPx
        : Number.POSITIVE_INFINITY;
    });
  }).toBeLessThanOrEqual(1);

  const check = await page.evaluate(async () => {
    const encoded = new URL(window.location.href).searchParams.get('state');
    if (!encoded) {
      return { ok: false, error: 'missing state parameter' };
    }

    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { state?: Record<string, unknown> };
    const state = decoded.state ?? {};

    const chr = typeof state.chr === 'string' ? state.chr : 'chr1';
    const assemblyId = typeof state.assemblyId === 'string' ? state.assemblyId : 'hg38';
    const centerBp =
      typeof state.centerBp === 'number' && Number.isFinite(state.centerBp) ? state.centerBp : 124_478_211;
    const bpPerPx =
      typeof state.bpPerPx === 'number' && Number.isFinite(state.bpPerPx) ? state.bpPerPx : 0.4;
    const binScale =
      typeof state.binScale === 'number' && Number.isFinite(state.binScale) ? state.binScale : 0.5;

    const [{ getAssembly }, { deriveWindowSpec }, { deriveTrackWindowSpec }, { loadComputationalPack }, { fetchComputationalTrackWindow }] =
      await Promise.all([
        import('/src/features/genome/registry.ts'),
        import('/src/data/trackDataLoader.ts'),
        import('/src/lib/trackWindowSpec.ts'),
        import('/src/data/computationalPack.ts'),
        import('/src/data/computationalDataSource.ts'),
      ]);

    const assembly = getAssembly(assemblyId);
    const chrLength = assembly?.chromSizes?.[chr] ?? 248_956_422;
    const widthPx = Math.max(
      280,
      Math.floor(document.querySelector('.ruler-canvas')?.getBoundingClientRect().width ?? 1000),
    );

    const halfSpan = (widthPx * bpPerPx) / 2;
    const rangeStart = Math.max(0, centerBp - halfSpan);
    const rangeEnd = Math.min(chrLength, centerBp + halfSpan);
    const viewport = {
      chr,
      chrLength,
      widthPx,
      centerBp,
      bpPerPx,
      range: {
        start: rangeStart,
        end: rangeEnd,
        span: Math.max(1, rangeEnd - rangeStart),
      },
    };

    const pack = await loadComputationalPack('/computational/packs/seqbro2-puffin.czpack');
    const track = {
      id: 'pw-zoom-seq',
      name: 'pw-zoom-seq',
      kind: 'signal' as const,
      color: '#000',
      height: 76,
      source: {
        type: 'computational' as const,
        packUrl: '/computational/packs/seqbro2-puffin.czpack',
        pack,
        subtrack: pack.subtracks[0],
      },
    };

    const baseSpec = deriveWindowSpec(chr, chrLength, centerBp, bpPerPx, widthPx, binScale);
    const requestSpec = deriveTrackWindowSpec(track, viewport, baseSpec);
    const features = await fetchComputationalTrackWindow(track.source, chr, requestSpec);

    return {
      ok: true,
      featureCount: features.length,
      bpPerPx,
      resolutionBp: baseSpec.resolutionBp,
      maxResolutionBp: pack.inference?.maxResolutionBp ?? null,
    };
  });

  expect(check.ok).toBe(true);
  expect(check.featureCount).toBeGreaterThan(0);
  if (typeof check.maxResolutionBp === 'number') {
    expect(check.resolutionBp).toBeLessThanOrEqual(check.maxResolutionBp);
  }
});
