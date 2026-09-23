# Computational Tracks (`.czpack`)

Sequence Browser now supports ONNX-based computational tracks through a pack manifest.

> **Bringing your own model?** The authoritative, formalized format contract is
> [`docs/czpack-spec.md`](./czpack-spec.md), with a JSON Schema at
> [`public/computational/czpack.schema.json`](../public/computational/czpack.schema.json)
> and a `czpack-author` agent skill in `.claude/skills/`. This page is the quick tour.

## Supported runtime

- `onnxruntime-web` (WASM execution provider, SIMD + threads)
- sequence input fetched from UCSC API (`api.genome.ucsc.edu`)

### Cross-origin isolation is required for speed

Multi-threaded WASM needs `SharedArrayBuffer`, which needs the page to be
cross-origin isolated. `vite.config.ts` sends these on the dev and preview
servers, and **any production host must send them too**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them nothing breaks visibly — inference just silently drops to one core.
`tests/e2e/inference-runtime.spec.ts` asserts `window.crossOriginIsolated`, so
losing the headers fails CI instead of quietly halving throughput.

The UCSC sequence API sends `Access-Control-Allow-Origin: *`, so its CORS-mode
fetches remain allowed under `require-corp`.

## Pack format

File extension: `.czpack` (JSON content)

```json
{
  "schemaVersion": 1,
  "id": "model-id",
  "name": "Model name",
  "assemblyId": "hg38",
  "sequenceProvider": {
    "type": "ucsc",
    "genome": "hg38"
  },
  "model": {
    "format": "onnx",
    "url": "/computational/models/model.onnx",
    "inputName": "input",
    "fixedInputs": {
      "threshold": 8
    }
  },
  "inference": {
    "flankBp": 14,
    "maxWindowBp": 14000000,
    "maxResolutionBp": 24
  },
  "subtracks": [
    {
      "id": "track-a",
      "name": "Track A",
      "kind": "signal",
      "color": "#77b6ff",
      "height": 76,
      "outputName": "output_human",
      "channelIndex": 0,
      "transform": "relu"
    }
  ]
}
```

## Built-in packs

The bundled packs live under `/computational/packs/`: Puffin
(`seqbro2-puffin.czpack`) and MotifMatch (`vibe-motifmatch.czpack`).

A product with models of its own supplies them through a site extension
(`src/features/site/extension.ts`): a directory outside this repository, named
by `VITE_SITE_EXTENSION` at build time, whose `site-extension.ts` adds catalog
entries and site profiles and whose `assets/` are copied into the build. A build
made without one carries only what this repository ships.

A pack's model scores the strand on screen. While the browser reads the minus
strand the worker feeds the reverse complement of the window and maps the
outputs back to genomic order, so a strand-specific model needs no strand
handling of its own and a model that emits both strands simply swaps them.

Any other pack is loaded at runtime: use **Models → Add another model** and give
it the `.czpack` URL or app-relative path. Nothing about the pack format is
specific to a bundled model -- multi-output packs, lazy output collections, and per-motif
attribution rows all still work, they simply are not shipped with the app.

Pack `plotGroups` can combine explicit `subtrackIds` and whole inference
`groupIds` into a single curve plot without making hidden outputs eager. The
track manager provides per-track visible-range autoscale, linked comparison
scales across regular and computational signals, explicit fixed limits, and a
DNA-height display for genuine one-value-per-base signals. DNA letters appear
only when legible; narrower bases use signed color cells and coarser data falls
back to the ordinary signal without inventing per-base values.

## Measured model cost

Inference time is **linear in window size**. Measured on an 18-core M-series Mac,
`onnxruntime-web` WASM at 4 threads, per kilobase of input:

| pack | ms per kb | declared `maxWindowBp` | cost at that limit |
| --- | --- | --- | --- |
| `vibe-motifmatch` | ~2.2 | 300,000 | ~0.7 s |
| `seqbro2-puffin` | ~59 | 86,000 | ~5 s |
| `seqbro2-motif` | ~168 | 300,000 | ~50 s |

Threading helps unevenly: 1 -> 4 threads takes motifmatch from 58 ms to 18 ms and
puffin from 75 ms to 48 ms, but makes motif slightly *slower* (its graph is many
small ops that do not parallelize). Four threads is the default compromise; see
`resolveWasmThreadCount` in `src/workers/computationalWorker.ts`.

### Windows are gated by a latency budget, not a fixed size

A pack's declared `maxWindowBp` is treated as a ceiling, not the actual limit. The
enforced cap is `min(maxWindowBp, budget ÷ measured_cost)` where the budget is
`INFERENCE_BUDGET_MS` (1 s) — so a single inference stays interactive regardless of
which model or device is in play. See `effectiveComputationalMaxWindowBp` in
`src/lib/computationalLimits.ts`.

The per-model cost is **measured on the current device**, because a static number
cannot hold: cost per base varies ~80× across the models above and several-fold
across devices. On pack import the worker runs a synthetic warm-up probe at two
input lengths (`handleWarmup`), derives ms/base, and reports it back; real runs
refine it thereafter. Until a model is calibrated the cap uses a conservative
assumed cost, so a large inference cannot fire before the measurement lands.

Concretely, puffin's declared 86 kb window (≈5 s) is cut to whatever fits 1 s on
the device — ~10 kb on a fast desktop, less on a laptop. The `?debug=1` buffer HUD
shows each pack's enforced cap and whether it is calibrated yet.

Because worker concurrency is 1, one wide window still stalls every other
computational track behind it. Chunking a budget-sized window into abortable pieces
is the natural next step for wide views.

### `flankBp` must match the model

`flankBp` is context the model consumes but emits no output for. It is
load-bearing: declare it wrong and every coordinate stretches silently, which
renders plausible-looking signal in the wrong place. The bundled packs were
verified against their models by running each at two input lengths:

| model | output length | implied crop | declared `flankBp` |
| --- | --- | --- | --- |
| `seqbro2-puffin` | `L - 650` | 325 per side | 325 |
| `seqbro2-motif` | `L - 28` | 14 per side | 14 |
| `vibe-motifmatch` | `L / 102.4` | downsampling | 0 |

To check a new pack, run the model at two input lengths and confirm the output
length drops by exactly `2 * flankBp`.

## Zoom gating

- Computational tracks only compute when zoomed in enough for the pack's `inference.maxResolutionBp`.
- Sequence strip uses letters at readable base widths, base-color cells at the
  next level out, and A/C/G/T composition through 12 kb.
- Model padding/context is handled with `inference.flankBp`, so model input can extend outside the visible window.
