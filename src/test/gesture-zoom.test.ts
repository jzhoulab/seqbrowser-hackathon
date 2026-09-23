import { describe, expect, it } from 'vitest';
import {
  GESTURE_ZOOM_GAIN,
  GESTURE_ZOOM_MAX_LOG_STEP,
  gestureZoomFactor,
} from '../lib/gestureZoom';

// Safari's pinch carries a scale counted from the start of the gesture. The
// factor returned here multiplies bp-per-pixel, so spreading (more scale, less
// sequence on screen) must come back below 1.

describe('gestureZoomFactor', () => {
  it('zooms in when the pinch spreads and out when it closes', () => {
    expect(gestureZoomFactor(1, 1.2)).toBeLessThan(1);
    expect(gestureZoomFactor(1, 0.8)).toBeGreaterThan(1);
  });

  it('holds still for a sample that did not move', () => {
    expect(gestureZoomFactor(1, 1)).toBe(1);
    expect(gestureZoomFactor(1.4, 1.40001)).toBe(1);
  });

  it('applies the gain to the finger movement', () => {
    // A pinch out to 1.2 shows 1.2^-2.35 of the sequence.
    expect(gestureZoomFactor(1, 1.2)).toBeCloseTo(1.2 ** -GESTURE_ZOOM_GAIN, 9);
  });

  it('zooms a whole pinch the same however many events the browser sent', () => {
    const total = (scales: number[]) =>
      scales.reduce(
        (carried, scale, index) => carried * gestureZoomFactor(index === 0 ? 1 : scales[index - 1]!, scale),
        1,
      );

    // Four coarse samples and forty fine ones describe the same 1.5x pinch.
    const coarse = total([1.12, 1.25, 1.37, 1.5]);
    const fine = total(Array.from({ length: 40 }, (_unused, index) => 1 + (0.5 * (index + 1)) / 40));

    expect(coarse).toBeCloseTo(1.5 ** -GESTURE_ZOOM_GAIN, 6);
    expect(fine).toBeCloseTo(coarse, 6);
  });

  it('caps one event, so a jumped sample cannot lurch the view', () => {
    expect(gestureZoomFactor(1, 100)).toBeCloseTo(Math.exp(-GESTURE_ZOOM_MAX_LOG_STEP), 9);
    expect(gestureZoomFactor(100, 1)).toBeCloseTo(Math.exp(GESTURE_ZOOM_MAX_LOG_STEP), 9);
  });

  it('ignores a scale that is missing, zero or not a number', () => {
    for (const [previous, scale] of [[1, 0], [0, 1], [1, Number.NaN], [Number.POSITIVE_INFINITY, 1], [1, -2]]) {
      expect(gestureZoomFactor(previous!, scale!)).toBe(1);
    }
  });
});
