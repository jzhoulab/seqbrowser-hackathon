import { describe, expect, it } from 'vitest';
import {
  CZPACK_SCHEMA_VERSION,
  normalizeComputationalPack,
  validateComputationalPack,
} from '../data/computationalPack';

function basePack(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'my-model',
    name: 'My Model',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: '/computational/models/my-model.onnx' },
    subtracks: [
      { id: 'a', name: 'A', kind: 'signal', color: '#77b6ff', height: 76, outputName: 'output' },
    ],
    ...overrides,
  };
}

describe('computational pack validation', () => {
  it('accepts a minimal valid pack and tolerates a $schema hint', () => {
    const result = validateComputationalPack(basePack({ $schema: '/computational/czpack.schema.json' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.id).toBe('my-model');
      expect(result.pack.subtracks).toHaveLength(1);
    }
  });

  it('reports the supported version when schemaVersion is wrong', () => {
    const result = validateComputationalPack(basePack({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(CZPACK_SCHEMA_VERSION));
    }
  });

  it('rejects a non-hex subtrack color', () => {
    const result = validateComputationalPack(
      basePack({
        subtracks: [
          { id: 'a', name: 'A', kind: 'signal', color: 'blue', height: 76, outputName: 'output' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/hex color/);
    }
  });

  it('rejects duplicate subtrack ids', () => {
    const result = validateComputationalPack(
      basePack({
        subtracks: [
          { id: 'dup', name: 'A', kind: 'signal', color: '#77b6ff', height: 76, outputName: 'out_a' },
          { id: 'dup', name: 'B', kind: 'signal', color: '#79d79e', height: 76, outputName: 'out_b' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/duplicate subtrack id/);
    }
  });

  it('keeps channelIndex so two subtracks can read one output', () => {
    const pack = normalizeComputationalPack(
      basePack({
        subtracks: [
          { id: 'h0', name: 'human[0]', kind: 'signal', color: '#77b6ff', height: 76, outputName: 'output_human', channelIndex: 0 },
          { id: 'h1', name: 'human[1]', kind: 'signal', color: '#79d79e', height: 76, outputName: 'output_human', channelIndex: 1 },
        ],
      }),
    );
    expect(pack.subtracks[0].channelIndex).toBe(0);
    expect(pack.subtracks[1].channelIndex).toBe(1);
  });

  it('preserves model-native output grouping and signed display metadata', () => {
    const pack = normalizeComputationalPack(
      basePack({
        subtracks: [
          {
            id: 'effect',
            name: 'Motif effect',
            kind: 'signal',
            color: '#77b6ff',
            height: 76,
            outputName: 'effect',
            groupId: 'motif-effects',
            groupLabel: 'Motif effects',
            defaultVisible: false,
            role: 'effect',
            scaleMode: 'signed',
          },
        ],
      }),
    );

    expect(pack.subtracks[0]).toMatchObject({
      groupId: 'motif-effects',
      groupLabel: 'Motif effects',
      defaultVisible: false,
      role: 'effect',
      scaleMode: 'signed',
    });
  });

  it('validates multi-series plot composition and dashed strand styling', () => {
    const pack = normalizeComputationalPack(
      basePack({
        subtracks: [
          {
            id: 'forward',
            name: 'Forward',
            kind: 'signal',
            color: '#172554',
            height: 76,
            outputName: 'forward',
            groupId: 'effects',
          },
          {
            id: 'reverse',
            name: 'Reverse',
            kind: 'signal',
            color: '#52678e',
            height: 76,
            outputName: 'reverse',
            groupId: 'reverse-effects',
          },
        ],
        plotGroups: [
          {
            id: 'effect-plot',
            label: 'Effects',
            groupIds: ['effects', 'reverse-effects'],
            dashedGroupIds: ['reverse-effects'],
            height: 104,
          },
        ],
      }),
    );

    expect(pack.plotGroups?.[0]).toEqual({
      id: 'effect-plot',
      label: 'Effects',
      subtrackIds: undefined,
      groupIds: ['effects', 'reverse-effects'],
      dashedSubtrackIds: undefined,
      dashedGroupIds: ['reverse-effects'],
      height: 104,
    });
  });

  it('accepts a signed base-height default with a stable computed-output margin', () => {
    const pack = normalizeComputationalPack(
      basePack({
        subtracks: [
          {
            id: 'contribution',
            name: 'Per-base contribution',
            kind: 'signal',
            color: '#77b6ff',
            height: 96,
            outputName: 'contribution',
            scaleMode: 'signed',
            defaultSignalDisplay: 'sequence',
            stableMarginBp: 325,
          },
        ],
      }),
    );

    expect(pack.subtracks[0]).toMatchObject({
      defaultSignalDisplay: 'sequence',
      stableMarginBp: 325,
    });
  });

  it('rejects a sequence display default for annotation outputs', () => {
    const result = validateComputationalPack(
      basePack({
        subtracks: [
          {
            id: 'annotation',
            name: 'Annotation',
            kind: 'annotation',
            color: '#77b6ff',
            height: 76,
            outputName: 'annotation',
            defaultSignalDisplay: 'sequence',
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects plot composition that references an unknown output group', () => {
    const result = validateComputationalPack(
      basePack({
        plotGroups: [{ id: 'missing', label: 'Missing', groupIds: ['not-defined'] }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown output group/);
    }
  });

  it('requires a UCSC sequence provider and an ONNX model', () => {
    expect(validateComputationalPack(basePack({ sequenceProvider: { type: 'ensembl', genome: 'hg38' } })).ok).toBe(false);
    expect(validateComputationalPack(basePack({ model: { format: 'tf', url: '/x' } })).ok).toBe(false);
  });
});
