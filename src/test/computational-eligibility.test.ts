import { afterEach, describe, expect, it } from 'vitest';
import { deriveComputationalEligibility } from '../lib/computationalEligibility';
import { recordInferenceCalibration, resetInferenceCalibration } from '../lib/computationalLimits';
import type { ComputationalPackManifest, ViewportState } from '../types';

const pack: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'test-model',
  name: 'Test model',
  assemblyId: 'hg38',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/models/test.onnx' },
  inference: { maxWindowBp: 10_000, maxResolutionBp: 8 },
  subtracks: [],
};

const viewport: ViewportState = {
  assemblyId: 'hg38',
  chr: 'chr1',
  chrLength: 248_956_422,
  widthPx: 1_000,
  centerBp: 10_000,
  bpPerPx: 2,
  range: { start: 9_000, end: 11_000, span: 2_000 },
};

afterEach(() => resetInferenceCalibration());

describe('computational eligibility', () => {
  it('pauses a fixed-reference model on another assembly', () => {
    const result = deriveComputationalEligibility(pack, { ...viewport, assemblyId: 'mm10' }, 1);

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('requires-assembly');
  });

  it('enforces the device-calibrated model window', () => {
    recordInferenceCalibration(pack.model.url, 0.01);
    const result = deriveComputationalEligibility(
      pack,
      { ...viewport, range: { start: 1_000, end: 12_000, span: 11_000 } },
      1,
    );

    expect(result.maxWindowBp).toBe(10_000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('window');
  });

  it('enforces the model resolution while allowing a compatible view', () => {
    recordInferenceCalibration(pack.model.url, 0.01);

    expect(deriveComputationalEligibility(pack, viewport, 9).reason).toBe('resolution');
    expect(deriveComputationalEligibility(pack, viewport, 8)).toMatchObject({ eligible: true, reason: null });
  });
});
