# `.czpack` — Bring Your Own Sequence Model

A **computational pack** (`.czpack`) is a small JSON manifest that turns an ONNX
sequence model into one or more live tracks in Sequence Browser. On import, the browser
fetches genomic sequence for the visible window, one-hot encodes it, runs your
model in a Web Worker (WASM, multi-threaded when the page is cross-origin
isolated), and renders the outputs as signal or annotation tracks — recomputing
as the user pans and zooms.

This document is the authoritative contract. The machine-checkable schema is
[`/computational/czpack.schema.json`](../public/computational/czpack.schema.json);
add `"$schema": "/computational/czpack.schema.json"` to your pack for editor
validation. To author or verify a pack with an agent, use the `czpack-author`
skill in `.claude/skills/`.

## Minimal example

```json
{
  "$schema": "/computational/czpack.schema.json",
  "schemaVersion": 1,
  "id": "my-model",
  "name": "My Model",
  "assemblyId": "hg38",
  "sequenceProvider": { "type": "ucsc", "genome": "hg38" },
  "model": {
    "format": "onnx",
    "url": "/computational/models/my-model.onnx",
    "inputName": "input",
    "fixedInputs": { "threshold": 8 }
  },
  "inference": { "flankBp": 0, "maxWindowBp": 100000, "maxResolutionBp": 24 },
  "plotGroups": [
    {
      "id": "score-by-strand",
      "label": "Score",
      "groupIds": ["overview"],
      "height": 96
    }
  ],
  "subtracks": [
    {
      "id": "score",
      "name": "Score",
      "kind": "signal",
      "color": "#77b6ff",
      "height": 76,
      "outputName": "output",
      "channelIndex": 0,
      "transform": "relu",
      "groupId": "overview",
      "groupLabel": "Overview",
      "defaultVisible": true,
      "role": "prediction",
      "scaleMode": "positive",
      "defaultSignalDisplay": "signal",
      "stableMarginBp": 0
    }
  ]
}
```

## The model contract

**Input.** The model receives DNA as a single float32 tensor:

- Shape `[1, 4, L]` — batch 1, 4 channels, length `L` (NCL layout).
- One-hot, channel order **A, C, G, T**. Any non-ACGT base (`N`, lowercase soft
  mask is upper-cased first) is an all-zero column.
- `L` is the fetched window length **including flanks** (see `flankBp`). It varies
  from run to run, so the model must accept a dynamic length axis.
- `model.inputName` selects this input; it defaults to the model's first input.

**Fixed inputs.** Each entry in `model.fixedInputs` is fed on every run as a
float32 tensor of shape `[1]`. Use this for constants your graph expects (e.g. a
threshold).

**Output.** Each subtrack names one `outputName`. The browser treats the tensor's
**last dimension as the position axis** and flattens any leading dimensions into
channels; `channelIndex` selects one. So `[1, C, P]` exposes `C` channels of
length `P`, and `[1, P]` (or `[P]`) is a single channel. `transform` (`identity` |
`abs` | `relu`) is applied per value, then values are mean-binned to the render
resolution.

**Output collections and display semantics.** Large models can expose many
subtracks without flooding the initial viewport. Subtracks with the same
`groupId` form a lazy inference collection: requesting one member prepares the
raw outputs for that collection, while other groups remain untouched.
`groupLabel` supplies its UI name and `defaultVisible: false` keeps an optional
output hidden until selected. `role` (`prediction` | `activation` | `effect` |
`contribution`) labels the scientific meaning. Use `scaleMode: "signed"` for
values that must retain negative contributions; these render around a centered
zero line with a symmetric local scale.

`defaultSignalDisplay: "sequence"` asks the browser to draw genuine one-value-
per-base output as signed A/C/G/T heights when the bases are wide enough. It
falls back to the ordinary signal plot when samples are binned or the view is
too wide; it never invents base-level values from a coarse bin. Users can switch
between the two displays without invalidating model or data caches.

For context-dependent outputs, `stableMarginBp` keeps the visible region that
many bases inside the computed output whenever the model/window budget permits.
This is distinct from `inference.flankBp`: flank maps valid model output to the
genome, while the stable margin prevents edge-conditioned values from being
shown at buffer handoffs. Declare the same value on every output of a pack:
outputs in different plots request different windows otherwise, and the model
rail can never report the view as computed.

`fixedScale: { min, max }` pins an output's y-axis to a range it owns by
construction -- a probability is `[0, 1]`, and auto-scaling one makes a flat
region look as tall as a confident peak. It is a property of the individual
output: a `scaleMode: "signed"` output must not carry it (the loader refuses),
because pinning a signed contribution clips whichever half falls outside.

`renderStyle: "bars" | "line"` says how to draw the values. `bars` is one mark
per base, for outputs that are genuinely one value per base (a splice-site
caller); joining those points draws interpolation the model never produced.
`line` (the default) joins them, for continuous signal. A composite plot is bars
if any member is.

`scaleShapes: ["complement-log"]` enables a y-axis shape beyond the linear,
power and log every signal offers. `complement-log` draws −log10(1 − p), so each
nine gets the same height: 0.99 and 0.99999, a pixel apart on a linear axis,
stand three fifths of the row apart, and faint lines mark 0.9, 0.99, 0.999 and
on. The top is five nines (0.99999), a little past the best splice call measured
(4.5 nines); a call past it draws at the top, as a linear axis draws anything
past 1, and the hover still reads its nines. The shape means something only for
a probability, so the loader accepts it only on a signal output whose
`fixedScale` lies inside `[0, 1]`. A row that draws several outputs on one axis
offers it only when every one of them enables it.

`mutagenesis: { contextBp, maxSpanBp }` declares a row that is derived from
`outputName`/`channelIndex` by exact in silico saturation mutagenesis rather
than read from the graph. For each base on screen the browser re-scores the
whole window three times, once per substitution, batched through the model; the
value is the summed absolute change in probability within `contextBp` of the
base, averaged over the three substitutions. It is unsigned: a base the calls
depend on and a base whose mutation would create a call both read high, and a
signed sum is not offered because losing one site typically raises its
neighbours, which inverts the sign at the bases that matter. That is three forward
passes per visible base, so the row is computed only while the view is at most
`maxSpanBp` wide and says so otherwise; results are cached per base. The model
must accept a batch dimension (`[batch, 4, length]`). Defaults: 500, 400.
A first-order (gradient) estimate of the same quantity is not offered: at a
saturated site the gradient is near zero while the mutation removes the call.

Nothing in the browser decides any of these from a pack's id or name. If a
behaviour needs to differ per model, it is declared here.

`plotGroups` composes enabled outputs into a single shared-axis, multi-color
curve plot without changing their lazy inference collections. Include specific
`subtrackIds`, whole `groupIds`, or both; their order is the curve order.
`dashedGroupIds` and `dashedSubtrackIds` are useful for opposite-strand curves.
When outputs are hidden, they simply drop out of the composite plot. All display
fields are optional, so v1 packs without composition retain one row per output.

Sequence editing needs nothing from a pack: every output shown on the reference
is re-run on the edited sequence and shown beneath the edited row, and the user
hides any of them there from its row. `comparesEdits` is still accepted on a
plot group for older manifests but no longer selects anything.

## `flankBp` — the load-bearing field

`flankBp` is the context your model consumes on **each side** of the requested
window but produces no output for. The browser fetches
`[requestStart - flankBp, requestEnd + flankBp]`, runs the model, and maps the
output back onto `[requestStart, requestEnd]`.

If `flankBp` is wrong, every value is drawn at the wrong coordinate — the signal
still looks plausible, just shifted or stretched. **Verify it** by running your
model at two input lengths:

- Fully convolutional "valid" models: `outputLength == inputLength - 2*flankBp`.
  Set `flankBp` to exactly half the shrinkage.
- Downsampling models (output much shorter than input): `flankBp` is usually `0`;
  the output is assumed to span the requested window.

## `transcriptPadding` — for transcript models

A model trained on transcripts rather than the genome typically saw N in place
of the sequence beyond each transcript's ends (a splice model trained that way: 500 N on each end of one
canonical transcript per gene, read on the transcript's strand). Declare
`"inference": { "transcriptPadding": { "bp": 500 } }` and the browser writes N
over the bases within that distance outside a same-strand canonical transcript
(MANE Select on hg38), on whichever strand is being scored, before running the
model. Bases inside another same-strand transcript are left alone. Without the
declaration the model reads the raw genome, which for such a model means calls
upstream of a transcript start that it never saw in training.

The bundled packs were verified this way:

| model | input→output | `flankBp` |
| --- | --- | --- |
| `seqbro2-puffin` | `L → L - 650` | 325 |
| `seqbro2-motif` | `L → L - 28` | 14 |
| `vibe-motifmatch` | `L → L / 102.4` | 0 |

## `maxWindowBp` and the latency budget

`maxWindowBp` is a **ceiling**, not the real limit. Inference cost is linear in
window size, so the browser measures your model's cost on the current device (a
short probe at import) and computes the enforced cap as
`min(maxWindowBp, ~1000ms ÷ measured_cost_per_base)`. Pick `maxWindowBp` from what
is scientifically meaningful; the budget keeps interaction smooth on any device.
See `src/lib/computationalLimits.ts`.

`maxResolutionBp` gates on zoom: the model only runs once the view is at least
that fine (bp per output bin), which stops accidental whole-chromosome inference.

## Hosting and importing

1. Put the `.onnx` file where it can be fetched (e.g. `public/computational/models/`).
   `model.url` resolves relative to the pack URL.
2. Put the `.czpack` somewhere fetchable (e.g. `public/computational/packs/`).
3. In the app: **Models → Add another model** → paste the `.czpack` URL/path.
   Each default-visible signal mounts as an ordinary track or joins its declared
   multi-series plot; optional collections remain available in the model's output picker. Zoom in past
   `maxResolutionBp` to trigger inference.

The sequence comes from the UCSC API (`api.genome.ucsc.edu`), which sends
`Access-Control-Allow-Origin: *`, so it works under the app's cross-origin
isolation headers.

## Validation rules (enforced on import)

- `schemaVersion` must be `1`.
- `id`, `name`, `sequenceProvider.genome`, `model.url`, and every subtrack
  `id`/`name`/`outputName` must be non-empty strings.
- `sequenceProvider.type` must be `"ucsc"`; `model.format` must be `"onnx"`.
- Subtrack `color` must be a hex color (`#rgb` or `#rrggbb`); `kind` must be
  `"signal"` or `"annotation"`; `transform`, if present, must be one of the three
  values; `height` is clamped to `>= 42`.
- `groupId`/`groupLabel` must be non-empty strings; `defaultVisible` must be a
  boolean; `role` and `scaleMode` must use their documented enum values.
- `scaleShapes` may list only `"complement-log"`, and only on a signal output
  whose `fixedScale` lies inside `[0, 1]`.
- Plot groups must reference known subtrack/output-group ids, have unique ids,
  and declare at least one `subtrackIds` or `groupIds` list.
- Subtrack `id`s must be unique within the pack.
- `flankBp`/`maxWindowBp`/`maxResolutionBp`, if present, must be finite numbers.

Unknown extra fields (like `$schema`) are ignored.
