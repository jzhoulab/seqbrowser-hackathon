# M0 Issue Progress (Subagent Wave)

This document tracks what was implemented in the parallel TDD wave and what is still pending for UI integration.

## Completed in this wave

- `CZ-001` Assembly registry and aliases.
  - Code: `src/features/genome/registry.ts`, `src/features/genome/types.ts`
  - Tests: `src/test/cz-001-assembly-registry.test.ts`

- `CZ-002` Genome switch core logic.
  - Code: `src/features/genome/switching.ts`
  - Tests: `src/test/cz-002-genome-switching.test.ts`

- `CZ-003` and `CZ-004` Source import validation (local + URL).
  - Code: `src/features/sources/importValidation.ts`
  - Tests: `src/test/cz-003-005-source-import-and-diagnostics.test.ts`

- `CZ-005` Source diagnostics classifier.
  - Code: `src/features/sources/diagnostics.ts`
  - Tests: `src/test/cz-003-005-source-import-and-diagnostics.test.ts`

- `CZ-006` Track manager domain operations.
  - Code: `src/features/tracks/manager.ts`
  - Tests: `src/test/cz-006-007-track-manager-settings.test.ts`

- `CZ-007` Track settings defaults and merge behavior.
  - Code: `src/features/tracks/settings.ts`
  - Tests: `src/test/cz-006-007-track-manager-settings.test.ts`

- `CZ-008` Session state codec (versioned base64url JSON).
  - Code: `src/features/session/stateCodec.ts`
  - Tests: `src/test/cz-008-session-state-codec.test.ts`

- `CZ-009` and `CZ-010` Search-domain primitives.
  - Code: `src/features/search/geneIndex.ts`, `src/features/search/jumpParser.ts`
  - Tests: `src/test/cz-009-010-gene-and-jump-search.test.ts`

- `CZ-011` UI load-state classification model.
  - Code: `src/features/ui/loadStates.ts`
  - Tests: `src/test/cz-011-ui-load-states.test.ts`

- `CZ-012` E2E baseline tests.
  - Code: `tests/e2e/smoke.spec.ts`, `tests/e2e/interaction.spec.ts`, `tests/playwright.config.ts`

- Test harness bootstrap.
  - Code: `vite.config.ts`, `package.json`
  - Tests: `src/test/app-shell.test.tsx`

- Computational tracks architecture context added.
  - Docs: `docs/architecture/adr-0001-computational-tracks.md`
  - Docs: `docs/architecture/computational-track-api.md`

## Correctness and performance pass

Fixes, each verified against the real models or the running app:

- Subtracks reading different channels of one model output all rendered channel 0.
  `outputSeries` was keyed by output name only; it is now keyed by name + channel.
  This was visible in `vibe-motifmatch`, where `human[1]` duplicated `human[0]`.
- Output coordinates are now derived from the *fetched* sequence via
  `deriveCoveredExtent`, so a window whose flanks are clipped at a chromosome edge
  reports the interval it actually covers instead of stretching to fill the request.
- Cross-origin isolation enabled, so WASM inference uses threads instead of one core.
- The production build was broken (`worker.format` defaulted to `iife`, which cannot
  code-split the worker's dynamic ORT import). Now set to `es`.
- The e2e suite pointed at port 4173 with `reuseExistingServer`, so it silently tested
  whatever else was serving on that port. Port is now configurable via `CZ_E2E_PORT`.
- Tracks no longer blank to white on every zoom step: stale-while-loading applies to
  all track types, not just computational ones.
- Removed ~3200 cache-key string parses per pan frame by hoisting the computational
  coverage index out of two per-frame `useMemo`s.
- Pointer-driven panning is coalesced to one React update per frame instead of one
  per pointer event (120Hz trackpads emitted 200+ per second).
- `RulerCanvas` reallocated its whole bitmap every frame; it now resizes only on change.
- CI runs lint, build, unit tests, and e2e on push.

## Latency-budgeted inference windows

The declared `maxWindowBp` values were far too large — puffin's 86 kb window is ~5 s
of inference, motif's 300 kb is ~50 s. The window a model may compute is now derived
from a 1 s latency budget divided by the model's **device-measured** cost:

- `src/lib/computationalLimits.ts` holds the budget, a per-model cost registry, and
  `effectiveComputationalMaxWindowBp` = `min(declared, budget ÷ cost)`, quantized to a
  coarse grid so the cap (and its cache keys) do not churn.
- The worker measures cost via a synthetic warm-up probe at import (`handleWarmup`,
  which also pre-warms the ONNX session) and refines it from real runs.
- The measurement crosses to the main thread over a new `calibration` worker message;
  gating recomputes reactively via `useSyncExternalStore`.
- The `?debug=1` buffer HUD surfaces each pack's enforced cap and calibration state.
- Fixed a staleness bug this exposed: `useTrackWindowData` derived its request window
  without depending on the measured cost, so after calibration it kept fetching the
  old (smaller) window while the rest of the app expected the new one.

## Frontend design pass

- Rebuilt the visual system on design tokens (surface/border/accent/shadow/radius) with
  a light and a dark theme, plus a header toggle that persists to localStorage.
- The data viewport is deliberately always "paper" (its canvases draw dark ink on
  white); dark mode themes only the surrounding chrome, so the tracks read as a bright
  panel floating in a calm dark shell. Light tokens are re-pinned locally on
  `.browser-scene` so viewport-internal DOM stays legible in dark mode.
- Header/command bar/side panel/status bar/ideogram are now cards with depth; controls,
  sliders, inputs, and buttons share consistent borders, focus rings, and hover states.
  Fixed the font stack (it fell back to `serif` off macOS).
- Fixed a latent layout feedback loop the redesign exposed: `.app-shell` used an `auto`
  grid column, so a toolbar wider than the viewport stretched the column, which widened
  the width-measured track canvases, which re-measured wider — unbounded. Pinned the
  column to `minmax(0, 1fr)`.

## Model-upload API formalized + agent skill

- `docs/czpack-spec.md` is now the authoritative `.czpack` contract: the input tensor
  layout (`[1,4,L]` one-hot, A/C/G/T, N→zero), output mapping (last dim = position axis,
  `channelIndex` selects a channel), `flankBp` semantics and how to measure it, and how
  `maxWindowBp` interacts with the latency budget.
- `public/computational/czpack.schema.json` — JSON Schema (draft-07) served statically;
  packs can reference it via `$schema` for editor validation.
- Validation hardened in `src/data/computationalPack.ts`: hex-color colors, unique
  subtrack ids, clearer version error, plus a non-throwing `validateComputationalPack`
  for tooling. Covered by `src/test/computational-pack-validation.test.ts`.
- `.claude/skills/czpack-author/` — an agent skill (with an `inspect-onnx.mjs` probe that
  derives input/output names and `flankBp` from the model) for authoring/debugging packs.

## Dark mode covers the data viewport

- Track and ruler canvases paint from a theme palette (`src/lib/viewportTheme.ts`) that
  the canvases subscribe to; the viewport DOM (labels, sequence strip) flips via
  `--viewport-*` CSS tokens. The whole browser now has a real dark mode, not just chrome.
- Fixed a runaway-width feedback loop the redesign exposed (`.app-shell` `auto` column →
  width-measured canvases stretched it unboundedly); pinned to `minmax(0, 1fr)`.

## Interaction: wheel routing is device-aware

Trackpad two-finger scroll and a physical wheel produce different `wheel` signatures,
so they are classified and routed differently (`src/lib/wheelSource.ts`, unit-tested):

| gesture | action |
| --- | --- |
| trackpad pinch (browser sets `ctrlKey`) | zoom |
| mouse wheel | zoom, anchored under the cursor |
| trackpad two-finger vertical | scroll the track list |
| horizontal | pan the genome |
| shift + vertical | scroll the track list (mouse escape hatch) |

Classification layers the signals that are actually reliable: `deltaMode !== 0` means a
wheel (Firefox), a legacy `wheelDeltaY` that is a whole multiple of 120 means a wheel
detent (Chromium/WebKit), fractional deltas or any horizontal drift mean a touchpad,
and magnitude is the last resort. The decision is **latched per gesture** for 180ms of
idle, so one stray sample cannot flip the view between scrolling and zooming mid-swipe.

Note for tests: Playwright's `page.mouse.wheel()` always reports `wheelDeltaY: 120`, so
it classifies as a mouse. Touchpad behavior is covered by dispatching fractional-delta
wheel events directly.

## Interaction: wheel zooms

- Mouse wheel now zooms in/out anchored under the cursor (the natural genome-browser
  gesture) instead of scrolling the track list. Horizontal wheel pans the genome;
  Shift+wheel scrolls the track list (via the Virtuoso `scrollerRef` threaded to App).
- Implemented as a native non-passive `wheel` listener on the scene, because React's
  delegated wheel listener is passive so `preventDefault` there cannot stop the list
  from also scrolling. Aligned `LABEL_WIDTH_PX` (190→196) with `--label-width` so the
  cursor zoom anchor is correct. Covered by a new interaction e2e test.

## Design system: instrument, not dashboard

The first pass was clean but generic (card + indigo + rounded corners reads as any
SaaS admin panel). Second pass gives the browser a point of view:

- **Two-color system.** Spectral cyan carries all UI chrome; **violet is reserved
  exclusively for live model inference**. Nothing else may use violet, so "computed
  on this device right now" is legible at a glance and never reads as file data.
- **Live inference has a visual language.** Model tracks get a violet spine, a tinted
  label lane, and a `MODEL` tag; every track gets a color chip tying the label column
  to its waveform plus a source tag (`BIGWIG`/`BIGBED`/`MODEL`). The old buffer HUD is
  now a "Live inference" instrument readout (pulse dot, muted buffer bars, per-model
  latency budget) instead of a raw debug dump with clipped text.
- **Locus as an address bar.** Assembly ▸ chr ▸ position collapsed into one segmented
  pill; the header split into `primary` (identity/locus/actions) and a sunken
  `transport` row (zoom/bin). Replaces seven stacked uppercase micro-labels that read
  as a data-entry form.
- **Tabular numerals** app-wide so coordinates stop jittering while panning.
- **Full dark instrument.** The chromosome navigator is a canvas, so it could not
  inherit CSS variables and stayed a glaring white bar; it now paints from the shared
  `viewportTheme` palette with an inverted Giemsa ramp for dark.
- `--label-width` widened to 220px (JS `LABEL_WIDTH_PX` kept in sync — it is
  load-bearing for the cursor zoom anchor) so model track names stop truncating.

## Signal value context (regional rank)

Auto-scaling each signal track to its local range is the right default but destroys any
sense of absolute magnitude: a background region and a strong peak render identically.
Each bigWig signal track now carries a rank of the current region against the whole
chromosome, plus a miniature distribution on the value axis.

Verified against the UCSC source (`kent/src/inc/bbiFile.h`, `src/lib/bbiWrite.c`) before
building, which changed the design three times:

- `sumData` is a sum over **bases** (`(end-start) * value`) and `validCount` counts bases,
  so `sumData/validCount` is an exact per-base mean. Zoom levels are built hierarchically
  and min/max/sum aggregate associatively, so summary stats are exact, not lossy.
- Summary bins are **not grid-aligned** — they chain from wherever data begins and are
  apportioned fractionally across boundaries. Quantiles must therefore be weighted by
  `validCount`; unweighted quantiles were off by 2x at p90 on ENCODE H3K27ac.
- Rigorous base-level exceedance bounds were prototyped and **abandoned**: at 12 kb bins
  P(value >= 10) bounds out at [0.01%, 29%], because nearly every bin straddles the
  threshold. Useless in practice.

The statistic is the **per-base mean of the region, ranked against same-width windows**
across the chromosome. Two earlier attempts were measurably wrong:

1. Ranking the view's max against single bins put every region in the top 1% — the max of
   ~1800 draws is essentially always extreme for one draw.
2. Ranking the max against same-width windows still failed, because past the finest zoom
   level the browser renders raw per-base values that no chromosome-wide reference can
   match.

A mean is resolution-independent by construction, so it is valid at any zoom. Measured on
ENCODE H3K27ac chr1: a gene desert reads p20 (axis max 5) while a promoter-rich region
reads p93 (axis max 332) — both of which auto-scaling draws at identical height.

Cost is one chromosome-wide summary read per (file, chromosome, zoom level), cached and
lazy: ~20k records / ~1 MB / a few ms. Ranks are suppressed below 60 comparable windows
rather than quoting a percentile that cannot support one.

Model tracks are out of scope for now — they have no precomputed summaries, and computing
one genome-wide means running the model genome-wide.

## Pending integration work

- Wire remaining domain modules into `src/App.tsx` and existing UI components.
- Build actual import flows, dialogs, and side-panel controls.
- Implement real gene annotation rendering and track/tooling UX using the new primitives.
- Chunk wide computational windows to a latency budget with per-chunk abort checks;
  see the measured costs in `computational-tracks.md`. Today one wide window can
  occupy the single worker slot for seconds and cannot be interrupted.
- Warm up ORT and the model session on pack import, so the first window does not pay
  the WASM download plus session creation.
- Give the sequence cache covering-interval lookup; it is keyed on exact coordinates,
  so a one-base pan refetches a near-identical sequence.
