export type WheelSource = 'mouse' | 'trackpad';

export type WheelSample = {
  deltaX: number;
  deltaY: number;
  /** 0 = pixel, 1 = line, 2 = page. */
  deltaMode: number;
  /** Legacy Chromium/WebKit field; absent in Firefox. */
  wheelDeltaY?: number;
};

// A physical wheel notch is one detent, which legacy `wheelDelta` reports as 120.
const WHEEL_DETENT = 120;
// Below this, an integer pixel delta is far more likely to be a touchpad glide than
// a wheel notch (real notches land at 40/53/100/120 depending on platform).
const MIN_WHEEL_NOTCH_PX = 40;

/**
 * Tell a physical mouse wheel apart from a touchpad two-finger scroll.
 *
 * There is no direct API for this, so we layer the signals that are actually
 * reliable, strongest first. Pinch is NOT handled here — browsers synthesize
 * `ctrlKey` on wheel events for pinch, so callers should branch on that before
 * asking about the source.
 */
export function classifyWheelSource(sample: WheelSample): WheelSource {
  // Firefox reports line/page deltas for a real wheel and pixel deltas for a
  // touchpad, which makes deltaMode decisive there.
  if (sample.deltaMode !== 0) {
    return 'mouse';
  }

  // Chromium and WebKit still expose legacy wheelDelta. A physical wheel reports
  // whole detents (multiples of 120); a touchpad reports arbitrary values.
  const legacy = sample.wheelDeltaY;
  if (typeof legacy === 'number' && legacy !== 0 && Math.abs(legacy) % WHEEL_DETENT === 0) {
    return 'mouse';
  }

  // Touchpads emit fractional deltas (momentum decay) and usually leak a little
  // horizontal drift; a wheel emits clean integers with deltaX exactly 0.
  if (!Number.isInteger(sample.deltaY) || sample.deltaX !== 0) {
    return 'trackpad';
  }

  // Fall back on magnitude: a lone small integer step is a glide, not a notch.
  return Math.abs(sample.deltaY) >= MIN_WHEEL_NOTCH_PX ? 'mouse' : 'trackpad';
}

/**
 * Wheel events arrive in bursts, and a single stray sample classifying differently
 * mid-gesture would flip the view between zooming and scrolling. Latch the first
 * decision and hold it until the gesture goes quiet.
 */
export const WHEEL_GESTURE_IDLE_MS = 180;

export type WheelGestureLatch = {
  source: WheelSource;
  lastEventAt: number;
};

export function resolveGestureSource(
  latch: WheelGestureLatch | null,
  sample: WheelSample,
  now: number,
): WheelSource {
  if (latch && now - latch.lastEventAt < WHEEL_GESTURE_IDLE_MS) {
    return latch.source;
  }
  return classifyWheelSource(sample);
}
