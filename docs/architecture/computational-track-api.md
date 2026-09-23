# Computational Track API (Online Inference)

This document defines the implementation contract for computational tracks (sequence -> model inference -> rendered track features).

## 1) Track Source Contract

Add a new track source variant:

```ts
type ComputationalTrackSource = {
  type: 'computational';
  modelId: string;            // Human-readable id, e.g. "dnabert2-signal-v1"
  modelHash: string;          // Immutable artifact hash (sha256 or content digest)
  preprocessHash: string;     // Tokenizer/normalization config hash
  sequenceVersion: string;    // Reference sequence dataset version
  inputWindowBp: number;      // Model receptive field
  strideBp: number;           // Step between windows
  maxBatchWindows?: number;   // Optional worker-side microbatch cap
};
```

## 2) Online Inference Interface

```ts
type InferenceRequest = {
  jobId: string;
  assemblyId: string;         // e.g. hg38
  chr: string;
  start: number;              // Visible/requested range start (bp)
  end: number;                // Visible/requested range end (bp)
  bpPerPx: number;
  resolutionBp: number;
  inputWindowBp: number;
  strideBp: number;
  leftContextToken?: string;  // Optional incremental context
  rightContextToken?: string;
  priority: 'visible' | 'near_prefetch' | 'far_prefetch';
  deadlineMs: number;         // SLA target for scheduler decisions
};

type InferenceResponse = {
  jobId: string;
  features: TrackFeature[];   // Existing render contract
  coveredStart: number;
  coveredEnd: number;
  rightContextToken?: string; // Reusable for neighbor windows
  backend: 'webgpu' | 'wasm' | 'cpu';
  elapsedMs: number;
};
```

Windowing rules:
- Align model windows to `strideBp` on genome coordinates.
- Expand each model invocation to `inputWindowBp`; merge outputs for `[start, end]`.
- Clip merged outputs to requested range before returning `TrackFeature[]`.

## 3) Context Caching

Context cache is optional but required when model supports incremental state.

Rules:
- Key context by deterministic request identity (see cache key section).
- Context token must encode model/hash compatibility; reject token on mismatch.
- Cache bounds: LRU + TTL (default 5 min) per `(track, chr)`.
- On cache miss, run full-window inference and emit new context token.

## 4) Worker + WebGPU Execution Model

Main thread responsibilities:
- Build aligned inference windows from viewport range.
- Prioritize visible requests, schedule prefetch when headroom exists.
- Maintain generation counter and ignore stale responses.

Worker responsibilities:
- Initialize model runtime and backend (`webgpu` preferred).
- Execute microbatches without blocking message loop.
- Honor `cancel(jobId)` between microbatch steps.

Message protocol:

```ts
type ToWorker =
  | { type: 'init'; modelId: string; modelHash: string; prefer: 'webgpu' | 'auto' }
  | { type: 'infer'; request: InferenceRequest }
  | { type: 'cancel'; jobId: string }
  | { type: 'dispose' };

type FromWorker =
  | { type: 'ready'; backend: 'webgpu' | 'wasm' | 'cpu' }
  | { type: 'result'; response: InferenceResponse }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId?: string; code: WorkerErrorCode; recoverable: boolean; message: string };

type WorkerErrorCode =
  | 'MODEL_LOAD_FAILED'
  | 'BACKEND_UNAVAILABLE'
  | 'OUT_OF_MEMORY'
  | 'TIMEOUT'
  | 'INVALID_OUTPUT';
```

Cancellation contract:
- Caller abort -> send `cancel(jobId)` immediately.
- Worker may return `cancelled` or no result.
- Late `result` for cancelled/stale `jobId` is ignored by caller.

## 5) Latency Budgets + Prefetch Policy

Targets:
- First visible paint: <= 60 ms P50, <= 150 ms P95.
- Visible refined data: <= 250 ms P50, <= 500 ms P95.
- Cancel response: <= 16 ms from viewport invalidation.

Scheduling policy during interaction:
- Pan:
  - queue `visible` range first
  - queue one `near_prefetch` window in pan direction
  - queue one trailing window only if worker idle
- Zoom-in:
  - queue anchor-centered high-resolution visible window
  - prefetch adjacent anchor-near windows
- Zoom-out:
  - queue coarse visible summary first
  - refine center window second

Drop policy:
- Cancel all `near_prefetch`/`far_prefetch` jobs on new viewport generation.
- Keep only latest `visible` job per track.

## 6) Deterministic Cache Keys

Use canonical integer bp coordinates and normalized ordering.

```txt
comp:
assembly={assemblyId}:
seq={sequenceVersion}:
model={modelId}@{modelHash}:
prep={preprocessHash}:
chr={chr}:
start={start}:
end={end}:
win={inputWindowBp}:
stride={strideBp}:
res={resolutionBp}:
ctx={contextHash|none}
```

Requirements:
- `start/end/win/stride/res` must be integer bp values.
- `modelHash`, `preprocessHash`, `sequenceVersion` must change on any artifact/content update.
- Cache key builder must be a single shared utility used by memory cache and persistent cache.

## 7) Failure Modes + Fallback Rendering

Failure handling matrix:
- `AbortError`/`cancelled`: no user-facing error, no state change.
- `BACKEND_UNAVAILABLE`: fallback backend (`wasm`/`cpu`) and mark track degraded.
- `OUT_OF_MEMORY`/`TIMEOUT`: clear in-flight job, keep stale cache if present, retry on next viewport settle.
- `MODEL_LOAD_FAILED`/`INVALID_OUTPUT`: disable computational mode for that track instance and show inline error badge.

Rendering fallback order:
1. Fresh inference result
2. Stale cached result (with subtle stale indicator)
3. Empty/no-data render with explicit reason (`loading`, `degraded`, `failed`)

## 8) Integration with Existing Loader

- Keep `TrackDataLoader.getWindow(track, chr, spec, signal)` unchanged at call sites.
- For `source.type === 'computational'`, delegate to computational inference adapter.
- Adapter must return `TrackWindowData` with the requested `spec` and deterministic `fetchedAt`.
