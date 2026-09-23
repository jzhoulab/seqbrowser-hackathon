import { clamp } from './genomeMath';

/**
 * A trackpad pinch as WebKit reports it.
 *
 * Safari is the only engine that sends `gesturestart`/`gesturechange`/
 * `gestureend` for a trackpad pinch, carrying a `scale` counted from the start
 * of the gesture (1.0), and it does NOT synthesize the ctrl-key wheel event
 * that Chromium and Firefox use for the same gesture. Those two go through the
 * wheel path; this is Safari's only way into the viewport.
 *
 * The type lives here because `GestureEvent` is WebKit-only and absent from
 * lib.dom, and its fields are read defensively for the same reason.
 */
export type TrackpadGestureEvent = Event & {
  readonly scale?: number;
  readonly clientX?: number;
  readonly clientY?: number;
};

/**
 * How far a pinch zooms, as an exponent on the finger movement: spreading to
 * 1.5x zooms in about 2.1x, to 2x about 5x. The touchscreen pinch applies the
 * same 2.35 to its log step, and a trackpad has far less room than a screen, so
 * a full pinch needs to be worth a real jump.
 */
export const GESTURE_ZOOM_GAIN = 2.35;

/**
 * The most one event may move the zoom, in log units (about 1.8x), so a jumped
 * sample cannot lurch the view. It sits well clear of ordinary samples: a
 * pinch reports every frame, and this only binds past a 29% scale change in
 * one event. Held tighter (0.35), it clipped a 20% sample, so the view fell
 * behind the fingers whenever a frame was slow.
 */
export const GESTURE_ZOOM_MAX_LOG_STEP = 0.6;

/** Below this a sample is noise rather than a pinch. */
const MIN_SCALE_RATIO_DELTA = 1e-4;

/**
 * The bp-per-pixel multiplier for a pinch that moved from `previousScale` to
 * `scale`. Spreading (a growing scale) shows less sequence, so the factor falls
 * below 1. Successive samples multiply, which keeps the zoom of a whole pinch
 * the same however many events the browser chose to send.
 */
export function gestureZoomFactor(previousScale: number, scale: number): number {
  if (!Number.isFinite(previousScale) || !Number.isFinite(scale) || previousScale <= 0 || scale <= 0) {
    return 1;
  }

  const ratio = previousScale / scale;
  if (Math.abs(ratio - 1) < MIN_SCALE_RATIO_DELTA) {
    return 1;
  }

  const logDelta = clamp(
    Math.log(ratio) * GESTURE_ZOOM_GAIN,
    -GESTURE_ZOOM_MAX_LOG_STEP,
    GESTURE_ZOOM_MAX_LOG_STEP,
  );
  return Math.exp(logDelta);
}
