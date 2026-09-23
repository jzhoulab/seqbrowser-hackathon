import { clamp } from './genomeMath';
import type { SignalDomain } from './signalScale';
import type { OptInSignalScaleShape, SignalScaleShape, TrackSpec } from '../types';

export type { OptInSignalScaleShape, SignalScaleShape };

/**
 * How a signal's value maps onto its plot height, between the same endpoints.
 *
 * Splice scores pile up near zero with a handful of sites near one, and the two
 * general shapes bend that distribution in opposite directions:
 *
 * - `power` pushes the low end down, so the near-certain sites stand alone and
 *   the background of weak scores flattens out of the way.
 * - `log` lifts the low end, so a weak site becomes visible at all.
 *
 * `complement-log` draws −log10(1 − p): every nine gets the same height, so a
 * 0.99 site and a 0.99999 site -- a pixel apart on a linear axis -- stand
 * three fifths of the row apart. It means something only for a probability,
 * so a track's config has to enable it (a manifest output's `scaleShapes`, or a
 * track spec's own); every other row cycles through the first three.
 *
 * None moves the endpoints, so the axis keeps printing the true range.
 */

/** The shapes every signal row offers, in the order the chip cycles them. */
export const SIGNAL_SCALE_SHAPES: readonly SignalScaleShape[] = ['linear', 'power', 'log'];

/** Shapes a track's config has to ask for, because they only mean something for some values. */
export const OPT_IN_SIGNAL_SCALE_SHAPES: readonly OptInSignalScaleShape[] = ['complement-log'];

export function isOptInSignalScaleShape(value: unknown): value is OptInSignalScaleShape {
  return typeof value === 'string' && (OPT_IN_SIGNAL_SCALE_SHAPES as readonly string[]).includes(value);
}

/**
 * Exponent of the power shape. At 2.5 a score of 0.5 draws at a fifth of the
 * height while 0.9 keeps three quarters, which separates confident calls from
 * the noise floor without flattening the merely-strong ones.
 */
const POWER_EXPONENT = 2.5;

/**
 * Curvature of the log shape. `log1p(t * K) / log1p(K)` keeps 0 and 1 fixed for
 * any K; K = 99 spreads the bottom hundredth of the range over the lower third
 * of the plot, which is about where a weak splice score stops being visible.
 */
const LOG_CURVE = 99;

/**
 * Top of the complement-log axis, in nines: p = 0.99999. On the 82 annotated
 * splice sites of seven genes (ACTB, GAPDH, TP53, HBB, MYC, KRAS, LMNA) the two
 * splice checkpoints measured peak at 3.7 and 4.5 nines, and not one of 103,548 bases
 * reaches 5; a seven-nine top left a third to a half of the row empty. A call
 * past the top draws at the top, as a linear axis draws anything past 1, and
 * the hover still reads its nines.
 */
export const COMPLEMENT_LOG_MAX_NINES = 5;

/**
 * The most nines a readout reports. A float32 probability steps by 6e-8 just
 * under 1, so 1 − p cannot be told apart below about 1e-7.
 */
const READOUT_MAX_NINES = 7;
const COMPLEMENT_FLOOR = 10 ** -READOUT_MAX_NINES;

/** Where a value sits on the complement-log axis, in nines: its own, up to the top. */
function axisNines(value: number): number {
  return Math.min(probabilityNines(value), COMPLEMENT_LOG_MAX_NINES);
}

/** −log10(1 − p): how many nines a probability has, up to what float32 can resolve. */
export function probabilityNines(probability: number): number {
  const p = clamp(probability, 0, 1);
  return Math.max(0, -Math.log10(Math.max(1 - p, COMPLEMENT_FLOOR)));
}

export function nextSignalScaleShape(
  shape: SignalScaleShape,
  shapes: readonly SignalScaleShape[] = SIGNAL_SCALE_SHAPES,
): SignalScaleShape {
  const index = shapes.indexOf(shape);
  return shapes[(index + 1) % shapes.length] ?? DEFAULT_SIGNAL_SCALE_SHAPE;
}

const SHAPE_LABELS: Record<SignalScaleShape, string> = {
  linear: 'lin',
  power: 'pow',
  log: 'log',
  'complement-log': '−log(1−p)',
};

export function signalScaleShapeLabel(shape: SignalScaleShape): string {
  return SHAPE_LABELS[shape];
}

const SHAPE_STATES: Record<SignalScaleShape, string> = {
  linear: 'Linear height.',
  power: 'Power height.',
  log: 'Log height.',
  'complement-log':
    `Height is −log10(1−p), from 0 to ${COMPLEMENT_LOG_MAX_NINES} nines: each nine gets the same height, ` +
    'and faint lines mark 0.9, 0.99, 0.999 and on.',
};

const SHAPE_OFFERS: Record<SignalScaleShape, string> = {
  linear: 'Click to return to a linear axis.',
  power: 'Click for a power axis, which flattens the weak background so confident sites stand alone.',
  log: 'Click for a log axis, which lifts weak scores into view.',
  'complement-log': 'Click for a −log(1−p) axis, which separates confident sites by their nines (0.99 from 0.9999).',
};

/** The chip's tooltip: what the row is drawing now, and what a click switches to. */
export function signalScaleShapeTitle(shape: SignalScaleShape, next: SignalScaleShape): string {
  return `${SHAPE_STATES[shape]} ${SHAPE_OFFERS[next]}`;
}

/** Apply a shape to a unit fraction. 0 and 1 are fixed points of every shape. */
export function shapeUnitValue(fraction: number, shape: SignalScaleShape): number {
  const t = clamp(fraction, 0, 1);
  if (shape === 'power') {
    return t ** POWER_EXPONENT;
  }
  if (shape === 'log') {
    return Math.log1p(t * LOG_CURVE) / Math.log1p(LOG_CURVE);
  }
  if (shape === 'complement-log') {
    return axisNines(t) / COMPLEMENT_LOG_MAX_NINES;
  }
  return t;
}

/**
 * Reshape a score within its own domain, leaving the domain endpoints untouched.
 *
 * The general shapes run on the distance from zero rather than on the raw
 * fraction, so a signed track keeps its baseline where it is and both
 * directions curve the same way. Endpoints being fixed is what lets the axis
 * keep printing the real minimum and maximum: only the space between them is
 * redistributed.
 */
export function applySignalScaleShape(
  score: number,
  domain: SignalDomain,
  shape: SignalScaleShape,
): number {
  if (shape === 'linear' || !Number.isFinite(score)) {
    return score;
  }
  if (shape === 'complement-log') {
    return applyComplementLog(score, domain);
  }

  const extent = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  if (!Number.isFinite(extent) || extent <= 0) {
    return score;
  }

  const sign = score < 0 ? -1 : 1;
  const magnitude = Math.abs(score);
  return sign * shapeUnitValue(magnitude / extent, shape) * extent;
}

/**
 * −log10(1 − p) between the domain's own endpoints. Unlike the general shapes
 * it reads the value itself, not a fraction of the axis: 0.99 has two nines
 * whether the axis runs to 1 or to 0.995. On the pinned [0, 1] axis of a
 * probability output this is simply nines / 5, anything past five at the top.
 */
function applyComplementLog(score: number, domain: SignalDomain): number {
  const span = domain.max - domain.min;
  const low = axisNines(domain.min);
  const high = axisNines(domain.max);
  if (!Number.isFinite(span) || span <= 0 || !(high > low)) {
    return score;
  }
  const fraction = clamp((axisNines(score) - low) / (high - low), 0, 1);
  return domain.min + fraction * span;
}

/**
 * A probability as the complement-log axis reads it: enough digits to show its
 * nines, then the nines. `toFixed(3)` printed 0.99 and 0.99999 both as "1.000"
 * -- exactly the difference the axis was switched on to show.
 */
export function formatProbabilityNines(probability: number): string {
  if (!Number.isFinite(probability)) {
    return String(probability);
  }
  const nines = probabilityNines(probability);
  // Three decimals like every other readout, more only as the nines need them.
  // (Trimming to the last non-zero digit printed a weak call of 0.0003 as "0".)
  const digits = clamp(Math.ceil(nines) + 1, 3, READOUT_MAX_NINES + 1);
  const value = clamp(probability, 0, 1).toFixed(digits).replace(/(\.\d{3}\d*?)0+$/, '$1');
  const ninesText = nines >= READOUT_MAX_NINES ? `≥${READOUT_MAX_NINES}` : nines.toFixed(1);
  return `${value} · −log(1−p) ${ninesText}`;
}

/**
 * The shape every track starts on: a value's height is simply its value.
 *
 * `power` reads better once you know what you are looking at, but it is a lie
 * about a first glance -- it flattens a 0.4 towards nothing, and a reader who
 * has not yet found the toggle has no way to know the row is bending its own
 * numbers. The toggle is one click away when the confident calls need
 * separating.
 */
export const DEFAULT_SIGNAL_SCALE_SHAPE: SignalScaleShape = 'linear';

export function defaultSignalScaleShape(): SignalScaleShape {
  return DEFAULT_SIGNAL_SCALE_SHAPE;
}

/**
 * Whether a track's config enables an opt-in shape. A model output enables it
 * in its manifest; a row drawing several outputs (a pack's plot, a user group)
 * shares one axis, so it takes the shape only if every series it draws does.
 */
function trackEnables(track: TrackSpec, shape: OptInSignalScaleShape): boolean {
  if (track.scaleShapes?.includes(shape)) {
    return true;
  }
  const source = track.source;
  if (source.type === 'group') {
    return source.members.length > 0 && source.members.every((member) => trackEnables(member, shape));
  }
  if (source.type === 'computational') {
    const seriesIds = source.seriesSubtrackIds ?? [source.subtrack.id];
    return seriesIds.every((id) => {
      const subtrack = id === source.subtrack.id
        ? source.subtrack
        : source.pack.subtracks.find((candidate) => candidate.id === id);
      return subtrack?.scaleShapes?.includes(shape) ?? false;
    });
  }
  return false;
}

/** The shapes this track's chip cycles through: the general three, then whatever its config enables. */
export function signalScaleShapesFor(track: TrackSpec): readonly SignalScaleShape[] {
  const enabled = OPT_IN_SIGNAL_SCALE_SHAPES.filter((shape) => trackEnables(track, shape));
  return enabled.length === 0 ? SIGNAL_SCALE_SHAPES : [...SIGNAL_SCALE_SHAPES, ...enabled];
}

/**
 * The shape a row draws with. A choice the track no longer allows (its model
 * was swapped for a checkpoint whose output does not enable it) falls back to
 * the default rather than drawing a probability axis on something that is not
 * one.
 */
export function resolveSignalScaleShape(track: TrackSpec): SignalScaleShape {
  const shape = track.scaleShape ?? DEFAULT_SIGNAL_SCALE_SHAPE;
  return signalScaleShapesFor(track).includes(shape) ? shape : DEFAULT_SIGNAL_SCALE_SHAPE;
}

/**
 * The shape the row's chip switches to next. One call from the track to a
 * string: the row must not hold the intermediate list, or the React Compiler
 * assumes the second call may mutate it (and the track it came from) and drops
 * the row's memoised draw callbacks.
 */
export function nextSignalScaleShapeFor(track: TrackSpec): SignalScaleShape {
  return nextSignalScaleShape(resolveSignalScaleShape(track), signalScaleShapesFor(track));
}
