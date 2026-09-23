# Sequence Browser

A genome browser built around real-time sequence-model inference, in the
browser: small ONNX models run locally on the DNA in view and their outputs
draw as ordinary tracks, re-scored as you pan, zoom, flip strand, or edit the
sequence. This is the hackathon build: everything the browser is, and two
models to start from.

## Run

```bash
npm install
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`). Genome data streams from
UCSC, so the first load needs the network; the models run entirely on your
machine, in a Web Worker, on WebAssembly with as many cores as the page is
allowed.

## The models that ship

Open **Models** in the top bar.

- **Puffin** (transcription initiation): predicts initiation at base-pair
  resolution and, for each of 18 motif classes, the contribution of the sequence
  to it. Try its demo to land on the ACTB promoter.
- **MotifMatch** (motif activity): learned human and mouse motif activity as
  signal tracks.

**Try … demo** prepares a model and opens its demo locus; **Run at current
locus** applies it to the region in view; **Remove**, on the model's header row
or its card, unmounts it. A model scores the strand on screen: flip the strand
and a minus-strand gene is scored on its reverse complement, and typing a gene
symbol into the **Jump** box opens the gene on its own strand. Zoom in, click a
base and type, or select bases and delete, and every model output on screen is
re-run on the edited DNA above the reference.

## Bring your own model

That is the point of the hackathon. A model reaches the browser as a `.czpack`:
a JSON manifest that names an ONNX file, describes its input, and declares each
output as a track. Load one at runtime under **Models → Add another model**,
by URL or app-relative path, or drop it under `public/computational/` and add
it to the catalog in `src/features/models/catalog.ts`.

- `docs/czpack-spec.md` is the contract: the tensor shapes, the flank, the
  window limits, every subtrack field, and what the browser derives (ISM rows,
  transcript padding, strand handling).
- `docs/computational-tracks.md` explains how a model becomes tracks and how
  inference is budgeted, with measured costs.
- `.claude/skills/czpack-author/` is a step-by-step guide to authoring and
  verifying a manifest for your own ONNX file, including how to measure the
  two values you must not guess (`flankBp` and the window limits). It is
  written for an AI coding assistant but reads fine as a checklist.

The model must accept `[batch, 4, length]` one-hot DNA (A, C, G, T) and emit
`[batch, channels, out]` with `out = length − 2·flank`. Anything that fits a
few hundred kilobytes and a few milliseconds per kilobase runs in real time.
A pack can also declare `mutagenesis` on an output, and the browser then
derives an ISM row from it -- an exact in silico saturation mutagenesis of the
bases on screen -- with no work on the model's side; `docs/czpack-spec.md`
has the details. The smallest complete pack is a single convolution and a
sigmoid over a one-hot window; `docs/computational-tracks.md` shows one.

## Controls

- Mouse wheel: zoom around cursor
- Drag on track canvas: pan genome
- Navigator strip (below the tracks): the current view plus 100 kb of context on
  each side, not the whole chromosome. Drag the brush to pan, drag its edges to
  resize, click to recentre. The window follows the view but holds still for the
  duration of a drag, so the brush moves against fixed ground. Its **source**
  picker chooses what the strip draws -- an annotation track (feature density) by
  default, or the cytoband ideogram.
- Keyboard:
  - `ArrowLeft` / `A`: pan left
  - `ArrowRight` / `D`: pan right
  - `+` / `=`: zoom in
  - `-` / `_`: zoom out
- Jump box supports a locus or a gene symbol:
  - `chr7:55200000`
  - `chr7:55100000-55300000`
  - `chr7:55200000@20`
  - `EGFR` — gene symbols resolve through UCSC's search API and list matching
    genes with their span and description. `Enter` takes the highlighted match,
    arrow keys move through the list. A locus is parsed locally and never waits
    on the network; only symbols are looked up remotely.

## Architecture

- `src/hooks/useGenomeViewport.ts`
  - viewport state (`centerBp`, `bpPerPx`)
  - wheel zoom anchoring
  - drag velocity sampling + inertial animation + bounce constraints
- `src/components/TrackList.tsx`
  - virtualized row rendering with `react-virtuoso`
- `src/components/TrackRowCanvas.tsx`
  - per-track canvas painter for visible window only
- `src/data/trackDataLoader.ts`
  - quantized request windows
  - deduplicated inflight requests
  - LRU cache for fetched windows
- `src/data/mockDataSource.ts`
  - deterministic async mock backend to emulate real-time loading latency

## Tests

```bash
npm run lint
npm test              # unit
npm run test:e2e      # browser (Playwright, Chromium)
```

## About

Sequence Browser is developed at the Zhou lab. This repository is a periodic
export of the development repository, with one squashed history; issues and
pull requests are welcome here and are carried back.
