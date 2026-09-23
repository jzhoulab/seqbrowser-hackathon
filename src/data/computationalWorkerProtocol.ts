import type { MutantOverlayData } from '../lib/mutagenesis';
import type { ComputationalPackManifest, DataWindowSpec, TrackFeature, TrackSource } from '../types';

export type ComputationalWorkerComputeRequest = {
  type: 'compute';
  requestId: number;
  /** `subtrack.groupId` selects the raw output collection; absent means pack-wide. */
  source: Extract<TrackSource, { type: 'computational' }>;
  chr: string;
  spec: DataWindowSpec;
};

export type ComputationalWorkerAbortRequest = {
  type: 'abort';
  requestId: number;
};

/**
 * Measure this model's inference cost on the current device with synthetic input.
 * Sent at pack import; it warms the default-visible output groups so the first
 * real window does not pay the WASM download plus graph optimization.
 */
export type ComputationalWorkerWarmupRequest = {
  type: 'warmup';
  requestId: number;
  pack: ComputationalPackManifest;
};

/**
 * The three mutant predictions a mutagenesis row kept for one base, for the
 * hover overlay. Answered from the worker's cache only; never computes.
 */
export type ComputationalWorkerMutantsRequest = {
  type: 'mutants';
  requestId: number;
  source: Extract<TrackSource, { type: 'computational' }>;
  chr: string;
  position: number;
};

export type ComputationalWorkerMutantsResponse = {
  type: 'mutants';
  requestId: number;
  overlay: MutantOverlayData | null;
};

export type ComputationalWorkerRequest =
  | ComputationalWorkerComputeRequest
  | ComputationalWorkerMutantsRequest
  | ComputationalWorkerAbortRequest
  | ComputationalWorkerWarmupRequest;

export type ComputationalWorkerResultResponse = {
  type: 'result';
  requestId: number;
  features: TrackFeature[];
};

/**
 * What a run has computed so far. A mutagenesis row takes seconds -- three
 * forward passes for every base on screen -- and every batch of bases is a
 * stretch of row that could already be drawn. Same shape as the result, and
 * superseded by the next partial or by the result itself.
 */
export type ComputationalWorkerPartialResponse = {
  type: 'partial';
  requestId: number;
  features: TrackFeature[];
};

export type ComputationalWorkerErrorResponse = {
  type: 'error';
  requestId: number;
  message: string;
  name?: string;
};

export type ComputationalWorkerCalibrationResponse = {
  type: 'calibration';
  requestId: number;
  modelUrl: string;
  msPerBp: number;
};

export type ComputationalWorkerResponse =
  | ComputationalWorkerResultResponse
  | ComputationalWorkerPartialResponse
  | ComputationalWorkerMutantsResponse
  | ComputationalWorkerErrorResponse
  | ComputationalWorkerCalibrationResponse;
