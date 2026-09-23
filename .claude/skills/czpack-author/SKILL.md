---
name: czpack-author
description: Author and verify a Sequence Browser .czpack manifest that brings a user's small ONNX sequence model into the browser as inference tracks. Use when someone wants to add/upload a sequence model, create a .czpack, debug a computational track that renders wrong/shifted/empty, or determine a model's flankBp / window limits. Covers the input/output tensor contract, measuring flankBp, choosing latency-budgeted limits, and testing the import.
---

# Authoring a `.czpack` for a user's sequence model

A `.czpack` is a JSON manifest that mounts an ONNX sequence model as live tracks.
The authoritative contract is `docs/czpack-spec.md`; the machine-checkable schema
is `public/computational/czpack.schema.json`. Read the spec once before authoring.
Your job is to produce a correct manifest, and correctness hinges on two measured
values — `flankBp` and the window limits — never guess them.

## Inputs you need from the user

- The `.onnx` file (and where it should be hosted; default `public/computational/models/`).
- The genome/assembly it was trained on (e.g. `hg38`) — must be a UCSC genome name.
- Which output(s) to display and, for multi-channel outputs, which channel per track.
- Any constant scalar inputs the graph needs (→ `model.fixedInputs`).

## Procedure

### 1. Inspect the model

Run the bundled probe from the repo root (it uses the project's `onnxruntime-web`):

```
node .claude/skills/czpack-author/inspect-onnx.mjs <path-to.onnx>
```

It prints input names, output names, and — by running the model at two input
lengths — how each output's length scales with input length. Use this to fill
`model.inputName`, each subtrack's `outputName`, and to derive `flankBp` (next step).
If the model needs scalar inputs to run, pass them: `... <path> threshold=8`.

### 2. Determine `flankBp` (load-bearing — get it exactly right)

`flankBp` is the context consumed on **each side** without emitted output. A wrong
value shifts/stretches every coordinate while still looking plausible, so measure it:

- **Valid-convolution model** (output length tracks input length): from the probe,
  `flankBp = (inputLength - outputLength) / 2`. It must be identical at both probe
  lengths. Example: `L=1024→374` and `L=2048→1398` both give `(L-650)/2 = 325`.
- **Downsampling model** (output much shorter than input, e.g. `L→L/102`): use
  `flankBp: 0`; the output is mapped across the full requested window.

### 3. Choose window limits

- `maxResolutionBp`: the coarsest bp-per-bin at which inference should run (24 is a
  good default). Below this zoom the model stays idle — this prevents whole-chromosome
  runs.
- `maxWindowBp`: the largest scientifically meaningful visible span. It is only a
  ceiling: the browser measures the model's per-base cost on the device and enforces
  `min(maxWindowBp, ~1000ms ÷ cost)` (see `src/lib/computationalLimits.ts`), so you do
  not need to hand-tune it for speed — pick what the model is meant for.

### 4. Write and validate the manifest

Write the `.onnx` to `public/computational/models/` and the `.czpack` to
`public/computational/packs/`. Follow `docs/czpack-spec.md`. The input contract is
fixed: DNA is fed as float32 `[1, 4, L]`, one-hot, channel order **A,C,G,T**, unknown
bases all-zero. Each subtrack reads `outputName` with the **last tensor dim as the
position axis**; `channelIndex` selects a channel; `transform` is `identity|abs|relu`.

Two subtracks may read the same `outputName` with different `channelIndex` — keep
them as separate subtracks with distinct `id`s.

Declare how each output should be shown; the browser never infers this from the
pack's id or name:

- `fixedScale: { min, max }` for an output whose range is fixed by construction
  (a probability is `[0, 1]`). Never on a `scaleMode: "signed"` output — the loader
  refuses, because pinning a signed contribution clips one half of it.
- `renderStyle: "bars"` for an output that is one value per base (a splice-site
  caller); the default `"line"` joins values and is right for continuous signal.
- `stableMarginBp` the **same on every output** of the pack. Outputs in different
  plots otherwise request different windows and the model rail never settles.
- `comparesEdits: true` on the plot group an edited sequence should be compared
  against (default: the first group). Editing is a browser feature that works
  for any model; this only picks which plot it shows.

Validate before testing (catches hex-color, version, uniqueness, and shape-of-manifest
errors without a browser):

```
node -e "import('./src/data/computationalPack.ts')" 2>/dev/null # if a runner is set up
```

or, more simply, add a focused vitest that calls `validateComputationalPack(<parsed pack>)`
and asserts `ok === true`, mirroring `src/test/computational-pack-validation.test.ts`.

### 5. Test the import end to end

Use the `run` skill (or `npm run dev`) to launch the app, then: **Import** → paste the
pack path → zoom in past `maxResolutionBp`. Confirm the track computes and the signal
lands on the expected coordinates. An e2e check can follow the pattern in
`tests/e2e/computational-import.spec.ts`.

## Debugging a wrong-looking track

- **Signal shifted or horizontally stretched** → `flankBp` is wrong. Re-measure with
  the probe (step 2); it is the cause ~every time.
- **Two subtracks show identical data** → they share an `outputName` but need different
  `channelIndex`; confirm each is set.
- **Track never computes / shows "Zoom in to <= N bp window"** → the view is wider than
  the enforced cap; zoom in, or raise `maxWindowBp` if the model is genuinely fast.
- **"Zoom in to <= N bp/bin"** → `maxResolutionBp` gate; zoom in further.
- **Import rejected** → the error names the exact field (see validation rules in
  `docs/czpack-spec.md`).
