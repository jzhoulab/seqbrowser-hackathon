import { afterEach, describe, expect, it } from 'vitest';
import {
  INFERENCE_BUDGET_MS,
  declaredComputationalMaxWindowBp,
  effectiveComputationalMaxWindowBp,
  recordInferenceCalibration,
  resetInferenceCalibration,
} from '../lib/computationalLimits';
import type { ComputationalPackManifest } from '../types';

function packWith(modelUrl: string, maxWindowBp?: number): ComputationalPackManifest {
  return {
    schemaVersion: 1,
    id: 'test',
    name: 'Test',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: modelUrl },
    inference: maxWindowBp ? { maxWindowBp } : undefined,
    subtracks: [],
  };
}

afterEach(() => {
  resetInferenceCalibration();
});

describe('budgeted computational max window', () => {
  it('stays well under the declared cap before any calibration', () => {
    const pack = packWith('/models/uncalibrated.onnx', 300_000);
    // The uncalibrated cap must be conservative — a first inference cannot be huge.
    expect(effectiveComputationalMaxWindowBp(pack)).toBeLessThan(10_000);
  });

  it('derives the cap from measured cost against the latency budget', () => {
    const pack = packWith('/models/fast.onnx', 300_000);
    // 0.0005 ms/bp -> budget/cost is far past the declared cap, so the cap holds.
    recordInferenceCalibration('/models/fast.onnx', 0.0005);
    expect(effectiveComputationalMaxWindowBp(pack)).toBe(300_000);

    // A slow model is capped so that cost * window stays within budget.
    const slow = packWith('/models/slow.onnx', 300_000);
    recordInferenceCalibration('/models/slow.onnx', 0.17);
    const cap = effectiveComputationalMaxWindowBp(slow);
    expect(cap).toBeLessThanOrEqual(6_000);
    // The worst-case cost at the cap must respect the budget (with safety head-room).
    expect(cap * 0.17).toBeLessThanOrEqual(INFERENCE_BUDGET_MS);
  });

  it('never exceeds the declared cap even for a very cheap model', () => {
    const pack = packWith('/models/cheap.onnx', 50_000);
    recordInferenceCalibration('/models/cheap.onnx', 0.0001);
    expect(effectiveComputationalMaxWindowBp(pack)).toBe(declaredComputationalMaxWindowBp(pack));
    expect(effectiveComputationalMaxWindowBp(pack)).toBe(50_000);
  });

  it('keeps every bundled model within a one-second budget at realistic cost', () => {
    // Measured ms/bp at 4 threads on an 18-core Mac; a slower device measures higher
    // and gets a proportionally smaller cap, so the budget still holds.
    const cases: Array<[string, number]> = [
      ['motifmatch', 0.0022],
      ['puffin', 0.048],
      ['motif', 0.168],
    ];
    for (const [name, msPerBp] of cases) {
      const pack = packWith(`/models/${name}.onnx`, 300_000);
      recordInferenceCalibration(`/models/${name}.onnx`, msPerBp);
      const cap = effectiveComputationalMaxWindowBp(pack);
      expect(cap * msPerBp, `${name} cap ${cap}bp`).toBeLessThanOrEqual(INFERENCE_BUDGET_MS);
    }
  });
});
