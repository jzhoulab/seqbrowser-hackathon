# ADR-0001: Computational Tracks via Online Sequence Inference

- Status: Proposed
- Date: 2026-02-15
- Owner: Browser track pipeline

## Context
Current tracks render from precomputed window fetches (`bigWig`, `bigBed`, mock). We need a new track class that computes values from sequence at runtime while preserving current pan/zoom responsiveness and cancellation behavior.

Key constraints:
- Windowed loading must remain compatible with virtualized row rendering.
- Inference must run off the main thread, preferably on WebGPU.
- Caching must be deterministic across genome builds, model versions, and app releases.
- Track rendering must degrade gracefully on runtime failures.

## Decision
Adopt a client-side computational track architecture with a typed online inference interface, worker-based execution, and deterministic multi-layer caches.

### 1) Online inference interface
- Browser requests are expressed as visible genomic windows (`chr`, `start`, `end`, `bpPerPx`).
- Scheduler converts visible windows into aligned model windows:
  - `inputWindowBp`: model receptive field size.
  - `strideBp`: output step between consecutive windows.
- Adjacent requests reuse context state (left/right context tokens) when model supports incremental decoding.
- Output is normalized into existing `TrackFeature[]` + `DataWindowSpec` shape.

### 2) Worker/WebGPU execution + cancellation
- Inference executes in dedicated workers; main thread only schedules and paints.
- Worker backend selection: `webgpu` first, fallback to `wasm/cpu`.
- Every request has `jobId`; cancellations propagate via `AbortSignal` + worker `cancel` message.
- Stale results are dropped by generation checks (viewport key must still match).

### 3) Latency budgets + prefetch during pan/zoom
- Budgets:
  - Visible-range first paint target: <= 60 ms P50, <= 150 ms P95.
  - Visible-range refined result target: <= 250 ms P50, <= 500 ms P95.
  - Cancellation reaction: <= 1 frame (16 ms) after viewport invalidation.
- Prefetch policy:
  - During pan: prioritize forward direction (velocity-weighted lead), keep one trailing window.
  - During zoom-in: prioritize finer-resolution windows around zoom anchor.
  - During zoom-out: prioritize coarser summary for expanded span first, then refine center.

### 4) Deterministic cache keys
Use canonical keys that include:
- `assemblyId`
- `sequenceVersion`
- `modelId` + `modelHash`
- `preprocessHash` (tokenization/normalization version)
- `chr`, `start`, `end`, `inputWindowBp`, `strideBp`, `resolutionBp`
- optional `contextHash` when incremental state is used

### 5) Failure modes + fallback rendering
- Recoverable failures (`AbortError`, transient worker busy, timeout): suppress hard error UI, keep previous data if available.
- Backend failure (`WebGPU unavailable`, OOM): switch to fallback backend and mark track as degraded.
- Non-recoverable model/load errors: show per-track error state; keep browser interactive.
- Render fallback order:
  1. fresh inference
  2. stale cached inference
  3. coarse summary or empty track with reason badge

## Consequences
Positive:
- Enables future ML-derived tracks without precomputed tile pipelines.
- Preserves current responsive viewport UX through cancellation and prioritization.
- Provides reproducible caches and debuggable behavior across genomes/models.

Tradeoffs:
- Adds worker/runtime complexity and model asset lifecycle concerns.
- Requires strict cache-key and version discipline to avoid cross-build contamination.
- Requires performance instrumentation to enforce latency SLOs.

## Implementation Notes
- Keep `TrackDataLoader` API stable; introduce a computational source adapter behind `fetchTrackWindow`.
- Roll out behind feature flag, starting with one signal-style computational track.
- Ship with timing/error metrics before enabling by default.
