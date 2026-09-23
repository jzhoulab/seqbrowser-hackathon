import { recordInferenceCalibration } from '../lib/computationalLimits';
import type { MutantOverlayData } from '../lib/mutagenesis';
import type { ComputationalPackManifest, DataWindowSpec, TrackFeature, TrackSource } from '../types';
import type {
  ComputationalWorkerRequest,
  ComputationalWorkerResponse,
} from './computationalWorkerProtocol';

/**
 * Two workers, two kinds of work.
 *
 * A prediction is one forward pass and takes a tenth of a second; a mutagenesis
 * row is three forward passes per base on screen and takes seconds. In one
 * worker the prediction of a freshly panned window queued behind whichever
 * mutagenesis batch was running, and the prediction tracks stood empty until the
 * attribution was done. Each lane has its own worker, its own ONNX session and
 * its own queue, so the prediction shows the moment its run finishes and the
 * mutagenesis catches up behind it.
 */
type Lane = 'prediction' | 'mutagenesis';

type PendingRequest = {
  lane: Lane;
  resolve: (features: TrackFeature[]) => void;
  reject: (error: unknown) => void;
  cleanupAbort?: () => void;
  /** What the run has computed so far, while it is still going. */
  onPartial?: (features: TrackFeature[]) => void;
};

type PendingWarmup = {
  lane: Lane;
  resolve: () => void;
};

const pendingRequests = new Map<number, PendingRequest>();
const pendingMutants = new Map<number, (overlay: MutantOverlayData | null) => void>();
// Warm-up resolves regardless of outcome — a failed calibration must never block a
// track import; the gate just falls back to its conservative uncalibrated cap.
const pendingWarmups = new Map<number, PendingWarmup>();
const workers: Record<Lane, Worker | null> = { prediction: null, mutagenesis: null };
// One warm-up per model per lane; kept as promises so a second caller waits for
// the first rather than starting another.
const warmups: Record<Lane, Map<string, Promise<void>>> = {
  prediction: new Map(),
  mutagenesis: new Map(),
};
let nextRequestId = 1;

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function laneFor(source: Extract<TrackSource, { type: 'computational' }>): Lane {
  return source.subtrack.mutagenesis ? 'mutagenesis' : 'prediction';
}

function terminateWorkerWithError(lane: Lane, reason: string): void {
  const error = new Error(reason);
  for (const [requestId, pending] of pendingRequests) {
    if (pending.lane !== lane) {
      continue;
    }
    pending.cleanupAbort?.();
    pending.reject(error);
    pendingRequests.delete(requestId);
  }
  for (const [requestId, warmup] of pendingWarmups) {
    if (warmup.lane !== lane) {
      continue;
    }
    pendingWarmups.delete(requestId);
    warmup.resolve();
  }

  if (lane === 'mutagenesis') {
    for (const [requestId, resolveMutants] of pendingMutants) {
      pendingMutants.delete(requestId);
      resolveMutants(null);
    }
  }
  const worker = workers[lane];
  if (worker) {
    worker.terminate();
    workers[lane] = null;
  }
  // A fresh worker must re-run warm-up, since its calibration lived in worker scope.
  warmups[lane].clear();
}

function handleWorkerMessage(event: MessageEvent<ComputationalWorkerResponse>): void {
  const response = event.data;
  if (!response) {
    return;
  }

  if (response.type === 'mutants') {
    const resolveMutants = pendingMutants.get(response.requestId);
    if (resolveMutants) {
      pendingMutants.delete(response.requestId);
      resolveMutants(response.overlay);
    }
    return;
  }

  // A run in progress, drawn as far as it has got. The request stays pending:
  // the result is still coming, and it is what gets cached.
  if (response.type === 'partial') {
    pendingRequests.get(response.requestId)?.onPartial?.(response.features);
    return;
  }

  if (response.type === 'calibration') {
    recordInferenceCalibration(response.modelUrl, response.msPerBp);
    const warmup = pendingWarmups.get(response.requestId);
    if (warmup) {
      pendingWarmups.delete(response.requestId);
      warmup.resolve();
    }
    return;
  }

  // An error carrying a warm-up id resolves that warm-up rather than surfacing.
  const warmup = pendingWarmups.get(response.requestId);
  if (warmup) {
    pendingWarmups.delete(response.requestId);
    warmup.resolve();
    return;
  }

  const pending = pendingRequests.get(response.requestId);
  if (!pending) {
    return;
  }
  pendingRequests.delete(response.requestId);
  pending.cleanupAbort?.();

  if (response.type === 'result') {
    pending.resolve(response.features);
    return;
  }

  const error = new Error(response.message);
  if (response.name) {
    error.name = response.name;
  }
  pending.reject(error);
}

function ensureWorker(lane: Lane): Worker {
  const existing = workers[lane];
  if (existing) {
    return existing;
  }

  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are unavailable in this environment.');
  }

  const worker = new Worker(
    new URL('../workers/computationalWorker.ts', import.meta.url),
    { type: 'module', name: `computational-${lane}` },
  );
  worker.onmessage = handleWorkerMessage;
  worker.onerror = () => {
    terminateWorkerWithError(lane, 'Computational worker failed unexpectedly.');
  };
  worker.onmessageerror = () => {
    terminateWorkerWithError(lane, 'Computational worker message deserialization failed.');
  };

  workers[lane] = worker;
  return worker;
}

function warmupLane(lane: Lane, pack: ComputationalPackManifest): Promise<void> {
  const modelUrl = pack.model.url;
  const existing = warmups[lane].get(modelUrl);
  if (existing) {
    return existing;
  }

  let runtimeWorker: Worker;
  try {
    runtimeWorker = ensureWorker(lane);
  } catch {
    return Promise.resolve();
  }

  const requestId = nextRequestId;
  nextRequestId += 1;

  const warmup = new Promise<void>((resolve) => {
    pendingWarmups.set(requestId, { lane, resolve });
    try {
      runtimeWorker.postMessage({
        type: 'warmup',
        requestId,
        pack,
      } satisfies ComputationalWorkerRequest);
    } catch {
      pendingWarmups.delete(requestId);
      warmups[lane].delete(modelUrl);
      resolve();
    }
  });
  warmups[lane].set(modelUrl, warmup);
  return warmup;
}

export async function fetchComputationalTrackWindow(
  source: Extract<TrackSource, { type: 'computational' }>,
  chr: string,
  spec: DataWindowSpec,
  signal?: AbortSignal,
  onPartial?: (features: TrackFeature[]) => void,
): Promise<TrackFeature[]> {
  if (signal?.aborted) {
    throw abortError();
  }

  const lane = laneFor(source);
  // The mutagenesis worker is created on first use, and it has to be calibrated
  // before its first window: a worker's window cap comes from its own measured
  // cost, and the uncalibrated cap would refuse the window the app just sized.
  if (lane === 'mutagenesis') {
    await warmupLane(lane, source.pack);
    if (signal?.aborted) {
      throw abortError();
    }
  }

  const requestId = nextRequestId;
  nextRequestId += 1;

  const runtimeWorker = ensureWorker(lane);

  return new Promise<TrackFeature[]>((resolve, reject) => {
    const pending: PendingRequest = { lane, resolve, reject, onPartial };

    if (signal) {
      const onAbort = () => {
        const current = pendingRequests.get(requestId);
        if (!current) {
          return;
        }

        pendingRequests.delete(requestId);
        current.cleanupAbort?.();
        try {
          runtimeWorker.postMessage({
            type: 'abort',
            requestId,
          } satisfies ComputationalWorkerRequest);
        } catch {
          // Ignore worker post failures during abort path.
        }
        reject(abortError());
      };

      signal.addEventListener('abort', onAbort, { once: true });
      pending.cleanupAbort = () => {
        signal.removeEventListener('abort', onAbort);
      };
    }

    pendingRequests.set(requestId, pending);

    try {
      runtimeWorker.postMessage({
        type: 'compute',
        requestId,
        source,
        chr,
        spec,
      } satisfies ComputationalWorkerRequest);
    } catch (error) {
      pendingRequests.delete(requestId);
      pending.cleanupAbort?.();
      reject(error);
    }
  });
}

/**
 * The three mutant predictions a mutagenesis row kept for one base, for the
 * hover overlay. Resolves null when the base has not been scored (or the worker
 * has since let it go); never starts a computation.
 */
export function fetchMutantPredictions(
  source: Extract<TrackSource, { type: 'computational' }>,
  chr: string,
  position: number,
): Promise<MutantOverlayData | null> {
  if (!source.subtrack.mutagenesis || !workers.mutagenesis) {
    return Promise.resolve(null);
  }
  const runtimeWorker = workers.mutagenesis;
  const requestId = nextRequestId;
  nextRequestId += 1;
  return new Promise<MutantOverlayData | null>((resolve) => {
    pendingMutants.set(requestId, resolve);
    try {
      runtimeWorker.postMessage({ type: 'mutants', requestId, source, chr, position } satisfies ComputationalWorkerRequest);
    } catch {
      pendingMutants.delete(requestId);
      resolve(null);
    }
  });
}

/**
 * Calibrate a model's inference cost on this device (and warm its session) so the
 * zoom gate can size windows to the latency budget. Runs at most once per model
 * URL, never rejects, and never blocks import — a failure just leaves the
 * conservative uncalibrated cap in place. Warms the prediction lane only; the
 * mutagenesis lane warms itself the first time a mutagenesis row is asked for,
 * since most sessions never turn one on.
 */
export function warmupComputationalModel(pack: ComputationalPackManifest): Promise<void> {
  return warmupLane('prediction', pack);
}
