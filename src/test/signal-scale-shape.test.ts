import { describe, expect, it } from 'vitest';

import {
  COMPLEMENT_LOG_MAX_NINES,
  SIGNAL_SCALE_SHAPES,
  applySignalScaleShape,
  defaultSignalScaleShape,
  formatProbabilityNines,
  nextSignalScaleShape,
  resolveSignalScaleShape,
  shapeUnitValue,
  signalScaleShapeLabel,
  signalScaleShapeTitle,
  signalScaleShapesFor,
  type SignalScaleShape,
} from '../lib/signalScaleShape';
import { signalRenderStyle } from '../lib/signalRenderStyle';
import type { TrackSpec } from '../types';

const UNIT_DOMAIN = { min: 0, max: 1 };
const SIGNED_DOMAIN = { min: -1, max: 1 };

describe('signal scale shapes', () => {
  it('leaves the domain endpoints where they are', () => {
    for (const shape of SIGNAL_SCALE_SHAPES) {
      expect(applySignalScaleShape(0, UNIT_DOMAIN, shape), shape).toBeCloseTo(0, 10);
      expect(applySignalScaleShape(1, UNIT_DOMAIN, shape), shape).toBeCloseTo(1, 10);
    }
  });

  it('passes values through unchanged on a linear axis', () => {
    for (const value of [0, 0.01, 0.3, 0.75, 1]) {
      expect(applySignalScaleShape(value, UNIT_DOMAIN, 'linear')).toBe(value);
    }
  });

  it('bends the two shapes in opposite directions', () => {
    const weak = 0.2;
    const linear = applySignalScaleShape(weak, UNIT_DOMAIN, 'linear');

    // Power flattens the weak background; log lifts it into view.
    expect(applySignalScaleShape(weak, UNIT_DOMAIN, 'power')).toBeLessThan(linear);
    expect(applySignalScaleShape(weak, UNIT_DOMAIN, 'log')).toBeGreaterThan(linear);
  });

  it('keeps confident sites tall while suppressing the rest on a power axis', () => {
    const confident = applySignalScaleShape(0.9, UNIT_DOMAIN, 'power');
    const middling = applySignalScaleShape(0.5, UNIT_DOMAIN, 'power');

    expect(confident).toBeGreaterThan(0.7);
    expect(middling).toBeLessThan(0.25);
    // The gap between a near-certain and a middling call widens, which is the
    // point of the shape.
    expect(confident - middling).toBeGreaterThan(0.9 - 0.5);
  });

  it('is monotonic, so ranking between sites never changes', () => {
    for (const shape of SIGNAL_SCALE_SHAPES) {
      let previous = -Infinity;
      for (let value = 0; value <= 1.0001; value += 0.02) {
        const shaped = applySignalScaleShape(value, UNIT_DOMAIN, shape);
        expect(shaped, `${shape} at ${value.toFixed(2)}`).toBeGreaterThanOrEqual(previous);
        previous = shaped;
      }
    }
  });

  it('keeps a signed track symmetric about its baseline', () => {
    for (const shape of SIGNAL_SCALE_SHAPES) {
      const positive = applySignalScaleShape(0.25, SIGNED_DOMAIN, shape);
      const negative = applySignalScaleShape(-0.25, SIGNED_DOMAIN, shape);

      expect(negative, shape).toBeCloseTo(-positive, 10);
    }
  });

  it('scales with the domain rather than assuming 0..1', () => {
    const domain = { min: 0, max: 250 };

    expect(applySignalScaleShape(250, domain, 'power')).toBeCloseTo(250, 6);
    expect(applySignalScaleShape(25, domain, 'power')).toBeCloseTo(0.1 ** 2.5 * 250, 6);
  });

  it('never pushes a reshaped value outside the domain extent', () => {
    // 'linear' is a pass-through by design -- an out-of-range score stays out of
    // range and is clamped where the axis is drawn, not here.
    for (const shape of SIGNAL_SCALE_SHAPES.filter((item) => item !== 'linear')) {
      for (const value of [-2, -1, 0, 0.5, 1, 4]) {
        const shaped = applySignalScaleShape(value, UNIT_DOMAIN, shape);
        expect(Math.abs(shaped), `${shape} at ${value}`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('survives a degenerate domain or a non-finite score', () => {
    expect(applySignalScaleShape(0.5, { min: 0, max: 0 }, 'log')).toBe(0.5);
    expect(applySignalScaleShape(Number.NaN, UNIT_DOMAIN, 'power')).toBeNaN();
  });

  it('clamps the unit helper to its own range', () => {
    expect(shapeUnitValue(-1, 'power')).toBe(0);
    expect(shapeUnitValue(4, 'log')).toBeCloseTo(1, 10);
  });

  it('cycles through the shapes and back', () => {
    let shape: SignalScaleShape = 'linear';
    const seen: SignalScaleShape[] = [];
    for (let index = 0; index < SIGNAL_SCALE_SHAPES.length; index += 1) {
      shape = nextSignalScaleShape(shape);
      seen.push(shape);
    }

    expect(seen).toEqual(['power', 'log', 'linear']);
  });

  describe('starting shape', () => {
    const computationalTrack = (role?: string): TrackSpec =>
      ({
        id: 't',
        name: 't',
        color: '#000',
        height: 36,
        kind: 'signal',
        source: {
          type: 'computational',
          pack: { id: 'p', name: 'p', subtracks: [], model: { format: 'onnx', url: '' } },
          packUrl: '',
          subtrack: { id: 's', name: 's', kind: 'signal', color: '#000', height: 36, outputName: 'o', role },
        },
      }) as unknown as TrackSpec;

    const bigwigTrack = {
      id: 'b',
      name: 'b',
      color: '#000',
      height: 36,
      kind: 'signal',
      source: { type: 'bigwig', url: 'x.bw' },
    } as unknown as TrackSpec;

    it('is linear, whatever the track carries', () => {
      expect(defaultSignalScaleShape()).toBe('linear');
      expect(resolveSignalScaleShape(computationalTrack('prediction'))).toBe('linear');
      expect(resolveSignalScaleShape(computationalTrack('activation'))).toBe('linear');
      expect(resolveSignalScaleShape(computationalTrack(undefined))).toBe('linear');
      expect(resolveSignalScaleShape(bigwigTrack)).toBe('linear');
    });

    it('honours an explicit choice over the default', () => {
      const track = { ...computationalTrack('prediction'), scaleShape: 'log' } as TrackSpec;

      expect(resolveSignalScaleShape(track)).toBe('log');
    });
  });
});

describe('which rows draw bars', () => {
  const computational = (packId: string): TrackSpec =>
    ({
      id: 't', name: 't', color: '#000', height: 36, kind: 'signal',
      source: {
        type: 'computational',
        pack: { id: packId, name: packId, subtracks: [], model: { format: 'onnx', url: '' } },
        packUrl: '',
        subtrack: { id: 's', name: 's', kind: 'signal', color: '#000', height: 36, outputName: 'o', role: 'prediction' },
      },
    }) as unknown as TrackSpec;

  const withStyle = (packId: string, renderStyle?: 'bars' | 'line') => {
    const track = computational(packId);
    if (track.source.type === 'computational') {
      track.source.subtrack = { ...track.source.subtrack, renderStyle };
    }
    return track;
  };

  it('draws an output that declares bars as per-base bars', () => {
    // One value per base: joining the points would draw interpolation the model
    // never emitted. Declared on the output, not inferred from the model's name.
    expect(signalRenderStyle(withStyle('demo-bars-2ch', 'bars'))).toBe('bars');
    expect(signalRenderStyle(withStyle('any-other-model', 'bars'))).toBe('bars');
  });

  it('draws a curve unless the output asks for bars, whatever the pack is called', () => {
    // Puffin's motif activations and MotifMatch's activity are continuous
    // signals. And an id that merely resembles a splice model's does not get bars.
    expect(signalRenderStyle(withStyle('seqbro2-puffin'))).toBe('line');
    expect(signalRenderStyle(withStyle('vibe-motifmatch'))).toBe('line');
    expect(signalRenderStyle(withStyle('splice-third-party-pack'))).toBe('line');
  });

  it('leaves plain data tracks drawing curves', () => {
    const bigwig = {
      id: 'b', name: 'b', color: '#000', height: 36, kind: 'signal',
      source: { type: 'bigwig', url: 'x.bw' },
    } as unknown as TrackSpec;

    expect(signalRenderStyle(bigwig)).toBe('line');
  });
});

describe('the −log(1−p) shape', () => {
  const shaped = (value: number, domain = UNIT_DOMAIN) => applySignalScaleShape(value, domain, 'complement-log');

  it('gives every nine the same height on a probability axis', () => {
    for (const [probability, nines] of [[0.9, 1], [0.99, 2], [0.999, 3], [0.9999, 4]] as const) {
      expect(shaped(probability), String(probability)).toBeCloseTo(nines / COMPLEMENT_LOG_MAX_NINES, 9);
    }
  });

  it('keeps the endpoints, and draws a saturated 1.0 at the top', () => {
    expect(shaped(0)).toBe(0);
    expect(shaped(1)).toBe(1);
    expect(shaped(1 - 1e-9)).toBe(1);
  });

  it('separates confident calls that a linear axis draws a pixel apart', () => {
    expect(0.99999 - 0.99).toBeLessThan(0.01);
    expect(shaped(0.99999) - shaped(0.99)).toBeCloseTo(3 / COMPLEMENT_LOG_MAX_NINES, 9);
  });

  it('is monotonic and never leaves the domain', () => {
    let previous = -Infinity;
    for (let value = -0.5; value <= 1.5; value += 0.01) {
      const height = shaped(value);
      expect(height, value.toFixed(2)).toBeGreaterThanOrEqual(previous);
      expect(height).toBeGreaterThanOrEqual(0);
      expect(height).toBeLessThanOrEqual(1);
      previous = height;
    }
  });

  it('keeps the endpoints of an auto-scaled axis too', () => {
    const domain = { min: 0, max: 0.3 };
    expect(shaped(0, domain)).toBe(0);
    expect(shaped(0.3, domain)).toBeCloseTo(0.3, 12);
    expect(shaped(0.15, domain)).toBeLessThan(0.15);
  });

  it('tops out at five nines, past the best real splice call measured, but reads a call past it', () => {
    expect(COMPLEMENT_LOG_MAX_NINES).toBe(5);
    expect(shaped(1 - 1e-6)).toBe(1);
    expect(formatProbabilityNines(1 - 1e-6)).toBe('0.999999 · −log(1−p) 6.0');
  });

  it('reads a hovered probability by its nines', () => {
    expect(formatProbabilityNines(0.99994)).toBe('0.99994 · −log(1−p) 4.2');
    expect(formatProbabilityNines(0.5)).toBe('0.500 · −log(1−p) 0.3');
    expect(formatProbabilityNines(0.0003)).toBe('0.000 · −log(1−p) 0.0');
    expect(formatProbabilityNines(1)).toBe('1.000 · −log(1−p) ≥7');
  });

  it('labels its chip with the formula', () => {
    expect(signalScaleShapeLabel('complement-log')).toBe('−log(1−p)');
    expect(signalScaleShapeTitle('log', 'complement-log')).toMatch(/−log\(1−p\) axis/);
    expect(signalScaleShapeTitle('complement-log', 'linear')).toMatch(/return to a linear axis/);
  });
});

describe('which rows offer −log(1−p)', () => {
  const probability = {
    id: 'donor', name: 'Donor', kind: 'signal', color: '#000', height: 36, outputName: 'pred',
    fixedScale: { min: 0, max: 1 }, scaleShapes: ['complement-log'],
  };
  const plain = { id: 'ism', name: 'ISM', kind: 'signal', color: '#000', height: 36, outputName: 'pred' };
  const pack = { id: 'p', name: 'p', subtracks: [probability, plain], model: { format: 'onnx', url: '' } };
  const output = (subtrack: typeof probability | typeof plain, seriesSubtrackIds?: string[]): TrackSpec =>
    ({
      id: subtrack.id, name: subtrack.name, color: '#000', height: 36, kind: 'signal',
      source: { type: 'computational', pack, packUrl: '', subtrack, ...(seriesSubtrackIds ? { seriesSubtrackIds } : {}) },
    }) as unknown as TrackSpec;
  const group = (members: TrackSpec[]): TrackSpec =>
    ({ id: 'g', name: 'g', color: '#000', height: 36, kind: 'signal', source: { type: 'group', members } }) as unknown as TrackSpec;

  it('offers it only where the output enables it', () => {
    expect(signalScaleShapesFor(output(probability))).toEqual(['linear', 'power', 'log', 'complement-log']);
    expect(signalScaleShapesFor(output(plain))).toEqual(['linear', 'power', 'log']);
  });

  it('cycles four shapes on an output that enables it, three elsewhere', () => {
    const shapes = signalScaleShapesFor(output(probability));
    let shape: SignalScaleShape = 'linear';
    const seen: SignalScaleShape[] = [];
    for (let index = 0; index < shapes.length; index += 1) {
      shape = nextSignalScaleShape(shape, shapes);
      seen.push(shape);
    }
    expect(seen).toEqual(['power', 'log', 'complement-log', 'linear']);
    expect(nextSignalScaleShape('log', signalScaleShapesFor(output(plain)))).toBe('linear');
  });

  it('offers it on a shared-axis row only when every series enables it', () => {
    expect(signalScaleShapesFor(output(probability, ['donor']))).toContain('complement-log');
    expect(signalScaleShapesFor(output(probability, ['donor', 'ism']))).not.toContain('complement-log');
    expect(signalScaleShapesFor(group([output(probability), output(probability)]))).toContain('complement-log');
    expect(signalScaleShapesFor(group([output(probability), output(plain)]))).not.toContain('complement-log');
  });

  it("lets any track's own config enable it", () => {
    const bigwig = {
      id: 'b', name: 'b', color: '#000', height: 36, kind: 'signal', source: { type: 'bigwig', url: 'x.bw' },
    } as unknown as TrackSpec;
    expect(signalScaleShapesFor(bigwig)).not.toContain('complement-log');
    expect(signalScaleShapesFor({ ...bigwig, scaleShapes: ['complement-log'] })).toContain('complement-log');
  });

  it('draws linear when the choice is not allowed on the row', () => {
    expect(resolveSignalScaleShape({ ...output(plain), scaleShape: 'complement-log' })).toBe('linear');
    expect(resolveSignalScaleShape({ ...output(probability), scaleShape: 'complement-log' })).toBe('complement-log');
  });
});
