import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  clamp,
  getCenterBounds,
  toRange,
  type CenterBounds,
  type GenomicRange,
} from '../lib/genomeMath';

type UseGenomeViewportArgs = {
  chrLength: number;
  widthPx: number;
  initialCenterBp: number;
  initialBpPerPx: number;
  minBpPerPx: number;
  maxBpPerPx: number;
  resetToken: string;
  panDamping?: number;
  /** The view is drawn mirrored (minus strand): a pan to the right moves genomic coordinates the other way. */
  mirrored?: boolean;
};

type UseGenomeViewportResult = {
  centerBp: number;
  bpPerPx: number;
  range: GenomicRange;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  zoomByWheel: (deltaY: number, deltaMode: number, anchorPx: number) => void;
  panByPixels: (deltaPx: number) => void;
  zoomByFactor: (factor: number, anchorPx?: number) => void;
  jumpToCenter: (nextCenter: number) => void;
  setExactBpPerPx: (nextBpPerPx: number) => void;
};

type DragState = {
  active: boolean;
  pointerId: number | null;
  lastX: number;
  lastTs: number;
  velocityPxMs: number;
};

type TouchPoint = {
  x: number;
  y: number;
};

/**
 * One finger on the glass. Undecided until it has moved far enough to be a
 * swipe rather than a tap, so a chip inside a track row still gets its click.
 */
type TouchDragState = {
  pointerId: number | null;
  axis: 'undecided' | 'pan' | 'scroll';
  startX: number;
  startY: number;
  lastX: number;
  lastTs: number;
  velocityPxMs: number;
};

const IDLE_TOUCH_DRAG: TouchDragState = {
  pointerId: null,
  axis: 'undecided',
  startX: 0,
  startY: 0,
  lastX: 0,
  lastTs: 0,
  velocityPxMs: 0,
};

/** Below this a touch is a tap; past it, the larger axis wins and keeps the gesture. */
const TOUCH_AXIS_LOCK_PX = 6;

/**
 * `setPointerCapture` throws for a pointer the browser does not know, which is
 * every synthetic pointer a test dispatches. Capturing is an optimisation --
 * it keeps the drag alive past the element's edge -- so losing it is not worth
 * losing the gesture.
 */
function capturePointer(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Not a real pointer; the drag still works without capture.
  }
}

type PinchState = {
  active: boolean;
  mode: 'undecided' | 'pan' | 'pinch';
  lastCenterX: number;
  lastDistance: number;
  lastTs: number;
  panVelocityPxMs: number;
};

function touchMetrics(points: Map<number, TouchPoint>): { centerX: number; distance: number } | null {
  const iterator = points.values();
  const first = iterator.next().value as TouchPoint | undefined;
  const second = iterator.next().value as TouchPoint | undefined;

  if (!first || !second) {
    return null;
  }

  const centerX = (first.x + second.x) * 0.5;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);

  return { centerX, distance };
}

const PAN_INERTIA_MIN_VELOCITY_BP_MS = 0.008;
const PAN_INERTIA_DECAY_PER_MS = 0.0027;
const PAN_SPRING_STRENGTH = 0.00105;
const PAN_SPRING_DAMPING_PER_MS = 0.0036;
const PAN_SOFT_BOUND_BOUNCE = -0.32;
const PAN_STOP_VELOCITY_BP_MS = 0.012;
const PAN_STOP_OFFSET_BP = 0.45;
const PAN_RELEASE_GAIN = 1.5;
const TOUCH_PAN_RELEASE_GAIN = 1.75;

const WHEEL_ZOOM_DELTA_SCALE = 0.0135;
const WHEEL_ZOOM_DELTA_CLAMP = 1.55;
const PINCH_ZOOM_DAMPING = 1.58;
const PINCH_ZOOM_MIN_FACTOR = 0.34;
const PINCH_ZOOM_MAX_FACTOR = 2.85;
const TOUCH_PAN_MIN_RELEASE_VELOCITY_PX_MS = 0.03;

export function useGenomeViewport({
  chrLength,
  widthPx,
  initialCenterBp,
  initialBpPerPx,
  minBpPerPx,
  maxBpPerPx,
  resetToken,
  panDamping = 1,
  mirrored = false,
}: UseGenomeViewportArgs): UseGenomeViewportResult {
  const [centerBp, setCenterBp] = useState(initialCenterBp);
  const [bpPerPx, setBpPerPx] = useState(initialBpPerPx);
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;

  const centerRef = useRef(centerBp);
  const bpPerPxRef = useRef(bpPerPx);
  const frameRef = useRef<number | null>(null);
  const frameTsRef = useRef<number | null>(null);
  const pendingCenterRef = useRef<number | null>(null);
  const centerFlushRef = useRef<number | null>(null);
  const lastResetTokenRef = useRef<string | null>(null);
  const panDampingRef = useRef(clamp(panDamping, 0.1, 1));
  const dragRef = useRef<DragState>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastTs: 0,
    velocityPxMs: 0,
  });
  const touchPointsRef = useRef<Map<number, TouchPoint>>(new Map());
  const touchDragRef = useRef<TouchDragState>({ ...IDLE_TOUCH_DRAG });
  const pinchRef = useRef<PinchState>({
    active: false,
    mode: 'undecided',
    lastCenterX: 0,
    lastDistance: 0,
    lastTs: 0,
    panVelocityPxMs: 0,
  });

  const clearTouchGesture = useCallback(() => {
    touchPointsRef.current.clear();
    touchDragRef.current = { ...IDLE_TOUCH_DRAG };
    pinchRef.current = {
      active: false,
      mode: 'undecided',
      lastCenterX: 0,
      lastDistance: 0,
      lastTs: 0,
      panVelocityPxMs: 0,
    };
  }, []);

  const getBounds = useCallback(
    (effectiveBpPerPx: number): CenterBounds => getCenterBounds(chrLength, effectiveBpPerPx, widthPx, 0.25),
    [chrLength, widthPx],
  );

  const getZoomBounds = useCallback((): { min: number; max: number } => {
    const fullChromosomeBpPerPx = chrLength / Math.max(1, widthPx);
    const effectiveMaxBpPerPx = clamp(fullChromosomeBpPerPx, minBpPerPx, maxBpPerPx);
    return { min: minBpPerPx, max: effectiveMaxBpPerPx };
  }, [chrLength, maxBpPerPx, minBpPerPx, widthPx]);

  const clampCenter = useCallback(
    (nextCenter: number, effectiveBpPerPx: number, soft = false): number => {
      const bounds = getBounds(effectiveBpPerPx);
      return clamp(
        nextCenter,
        soft ? bounds.softMin : bounds.strictMin,
        soft ? bounds.softMax : bounds.strictMax,
      );
    },
    [getBounds],
  );

  const setCenter = useCallback((nextCenter: number) => {
    // An explicit set (keyboard, zoom, inertia tick, search jump) is authoritative,
    // so drop any coalesced drag position still waiting on a frame — otherwise that
    // stale frame would land afterwards and jump the view backwards.
    if (centerFlushRef.current !== null) {
      cancelAnimationFrame(centerFlushRef.current);
      centerFlushRef.current = null;
    }
    pendingCenterRef.current = null;
    centerRef.current = nextCenter;
    setCenterBp(nextCenter);
  }, []);

  // Pointer events arrive faster than the display refreshes — a 120Hz trackpad can
  // emit 200+ moves per second, each of which would otherwise re-render the whole
  // app. The ref is updated immediately so the next move computes from the live
  // position; React only sees the latest value, at most once per frame.
  const flushCenter = useCallback(() => {
    centerFlushRef.current = null;
    const pending = pendingCenterRef.current;
    pendingCenterRef.current = null;
    if (pending !== null) {
      setCenterBp(pending);
    }
  }, []);

  const scheduleCenter = useCallback(
    (nextCenter: number) => {
      centerRef.current = nextCenter;
      pendingCenterRef.current = nextCenter;
      if (centerFlushRef.current === null) {
        centerFlushRef.current = requestAnimationFrame(flushCenter);
      }
    },
    [flushCenter],
  );

  useEffect(
    () => () => {
      if (centerFlushRef.current !== null) {
        cancelAnimationFrame(centerFlushRef.current);
      }
    },
    [],
  );

  const setZoom = useCallback((nextBpPerPx: number) => {
    bpPerPxRef.current = nextBpPerPx;
    setBpPerPx(nextBpPerPx);
  }, []);

  const stopInertia = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      frameTsRef.current = null;
    }
  }, []);

  const stopZoomInertia = useCallback(() => {}, []);

  const zoomByLogDelta = useCallback(
    (logDelta: number, anchorPx = widthPx * 0.5): boolean => {
      if (widthPx <= 0 || !Number.isFinite(logDelta) || Math.abs(logDelta) < 1e-8) {
        return false;
      }

      const zoomBounds = getZoomBounds();
      const logMin = Math.log(zoomBounds.min);
      const logMax = Math.log(zoomBounds.max);
      const prevBpPerPx = bpPerPxRef.current;
      const prevLog = Math.log(prevBpPerPx);
      const nextLog = clamp(prevLog + logDelta, logMin, logMax);
      if (Math.abs(nextLog - prevLog) < 1e-8) {
        return false;
      }

      const nextBpPerPx = Math.exp(nextLog);
      const boundedAnchor = clamp(anchorPx, 0, widthPx);
      const start = centerRef.current - (widthPx * prevBpPerPx) / 2;
      const anchorBp = start + boundedAnchor * prevBpPerPx;
      const nextStart = anchorBp - boundedAnchor * nextBpPerPx;
      const nextCenter = nextStart + (widthPx * nextBpPerPx) / 2;

      stopInertia();
      setZoom(nextBpPerPx);
      setCenter(clampCenter(nextCenter, nextBpPerPx, true));
      return true;
    },
    [clampCenter, getZoomBounds, setCenter, setZoom, stopInertia, widthPx],
  );

  const startInertia = useCallback(
    (initialVelocityBpMs: number) => {
      stopInertia();

      if (Math.abs(initialVelocityBpMs) < PAN_INERTIA_MIN_VELOCITY_BP_MS) {
        setCenter(clampCenter(centerRef.current, bpPerPxRef.current));
        return;
      }

      let velocityBpMs = initialVelocityBpMs;

      const tick = (timestamp: number) => {
        const previousTs = frameTsRef.current ?? timestamp;
        const dt = Math.min(40, timestamp - previousTs);
        frameTsRef.current = timestamp;

        let nextCenter = centerRef.current + velocityBpMs * dt;
        velocityBpMs *= Math.exp(-PAN_INERTIA_DECAY_PER_MS * dt);

        const bounds = getBounds(bpPerPxRef.current);
        const snappedCenter = clamp(nextCenter, bounds.strictMin, bounds.strictMax);
        const springOffset = nextCenter - snappedCenter;

        if (Math.abs(springOffset) > 0.001) {
          velocityBpMs += -springOffset * PAN_SPRING_STRENGTH * dt;
          velocityBpMs *= Math.exp(-PAN_SPRING_DAMPING_PER_MS * dt);
        }

        if (nextCenter < bounds.softMin || nextCenter > bounds.softMax) {
          nextCenter = clamp(nextCenter, bounds.softMin, bounds.softMax);
          velocityBpMs *= PAN_SOFT_BOUND_BOUNCE;
        }

        setCenter(nextCenter);

        const done =
          Math.abs(velocityBpMs) < PAN_STOP_VELOCITY_BP_MS &&
          Math.abs(springOffset) < PAN_STOP_OFFSET_BP;
        if (done) {
          setCenter(clamp(nextCenter, bounds.strictMin, bounds.strictMax));
          stopInertia();
          return;
        }

        frameRef.current = requestAnimationFrame(tick);
      };

      frameRef.current = requestAnimationFrame(tick);
    },
    [clampCenter, getBounds, setCenter, stopInertia],
  );

  const zoomAround = useCallback(
    (factor: number, anchorPx = widthPx * 0.5) => {
      if (widthPx <= 0) {
        return;
      }

      stopInertia();
      stopZoomInertia();

      const previousBpPerPx = bpPerPxRef.current;
      const zoomBounds = getZoomBounds();
      const nextBpPerPx = clamp(previousBpPerPx * factor, zoomBounds.min, zoomBounds.max);
      if (Math.abs(nextBpPerPx - previousBpPerPx) < 1e-9) {
        return;
      }

      const boundedAnchor = clamp(anchorPx, 0, widthPx);
      const start = centerRef.current - (widthPx * previousBpPerPx) / 2;
      const anchorBp = start + boundedAnchor * previousBpPerPx;
      const nextStart = anchorBp - boundedAnchor * nextBpPerPx;
      const nextCenter = nextStart + (widthPx * nextBpPerPx) / 2;

      setZoom(nextBpPerPx);
      setCenter(clampCenter(nextCenter, nextBpPerPx, true));
    },
    [clampCenter, getZoomBounds, setCenter, setZoom, stopInertia, stopZoomInertia, widthPx],
  );

  const panByPixels = useCallback(
    (deltaPx: number) => {
      stopInertia();
      stopZoomInertia();
      // Every pan gesture (drag, swipe, keys, inertia) arrives here in screen
      // pixels; on a mirrored view screen-right is genomic-left.
      const adjustedDeltaPx = deltaPx * panDampingRef.current * (mirroredRef.current ? -1 : 1);
      const nextCenter = centerRef.current + adjustedDeltaPx * bpPerPxRef.current;
      setCenter(clampCenter(nextCenter, bpPerPxRef.current, true));
    },
    [clampCenter, setCenter, stopInertia, stopZoomInertia],
  );

  const jumpToCenter = useCallback(
    (nextCenter: number) => {
      stopInertia();
      stopZoomInertia();
      setCenter(clampCenter(nextCenter, bpPerPxRef.current));
    },
    [clampCenter, setCenter, stopInertia, stopZoomInertia],
  );

  const setExactBpPerPx = useCallback(
    (nextBpPerPx: number) => {
      stopInertia();
      stopZoomInertia();
      const zoomBounds = getZoomBounds();
      const bounded = clamp(nextBpPerPx, zoomBounds.min, zoomBounds.max);
      setZoom(bounded);
      setCenter(clampCenter(centerRef.current, bounded));
    },
    [clampCenter, getZoomBounds, setCenter, setZoom, stopInertia, stopZoomInertia],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') {
        touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touchPointsRef.current.size < 2) {
          // One finger. Nothing is claimed yet: the move handler decides
          // whether this is a swipe along the genome or the start of a scroll
          // down the track list, and a touch that never travels stays a tap.
          stopInertia();
          stopZoomInertia();
          touchDragRef.current = {
            ...IDLE_TOUCH_DRAG,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastTs: performance.now(),
          };
          return;
        }

        // A second finger: the pinch owns the gesture from here.
        touchDragRef.current = { ...IDLE_TOUCH_DRAG };
        event.preventDefault();
        stopInertia();
        stopZoomInertia();
        capturePointer(event.currentTarget, event.pointerId);

        const metrics = touchMetrics(touchPointsRef.current);
        if (metrics) {
          const now = performance.now();
          dragRef.current.active = false;
          dragRef.current.pointerId = null;
          pinchRef.current = {
            active: true,
            mode: 'undecided',
            lastCenterX: metrics.centerX,
            lastDistance: metrics.distance,
            lastTs: now,
            panVelocityPxMs: 0,
          };
        }
        return;
      }

      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      stopInertia();
      stopZoomInertia();

      dragRef.current = {
        active: true,
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastTs: performance.now(),
        velocityPxMs: 0,
      };

      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [stopInertia, stopZoomInertia],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') {
        const point = touchPointsRef.current.get(event.pointerId);
        if (!point) {
          return;
        }

        point.x = event.clientX;
        point.y = event.clientY;

        if (touchPointsRef.current.size < 2) {
          const touchDrag = touchDragRef.current;
          if (touchDrag.pointerId !== event.pointerId) {
            return;
          }

          if (touchDrag.axis === 'undecided') {
            const travelX = event.clientX - touchDrag.startX;
            const travelY = event.clientY - touchDrag.startY;
            if (Math.hypot(travelX, travelY) < TOUCH_AXIS_LOCK_PX) {
              return;
            }
            touchDrag.axis = Math.abs(travelX) > Math.abs(travelY) ? 'pan' : 'scroll';
            touchDrag.lastX = event.clientX;
            touchDrag.lastTs = performance.now();
            if (touchDrag.axis === 'scroll') {
              // Down the track list, which the browser scrolls itself; letting
              // go of the pointer keeps its momentum and rubber-banding.
              touchDragRef.current = { ...IDLE_TOUCH_DRAG };
              return;
            }
            capturePointer(event.currentTarget, event.pointerId);
          }

          event.preventDefault();
          const nowMs = performance.now();
          const elapsed = Math.max(1, nowMs - touchDrag.lastTs);
          const travelled = event.clientX - touchDrag.lastX;
          const adjustedTravel = travelled * panDampingRef.current * (mirroredRef.current ? -1 : 1);
          touchDrag.velocityPxMs = adjustedTravel / elapsed;
          touchDrag.lastX = event.clientX;
          touchDrag.lastTs = nowMs;
          scheduleCenter(
            clampCenter(centerRef.current - adjustedTravel * bpPerPxRef.current, bpPerPxRef.current, true),
          );
          return;
        }

        const metrics = touchMetrics(touchPointsRef.current);
        if (!metrics) {
          return;
        }
        event.preventDefault();

        const pinch = pinchRef.current;
        if (!pinch.active) {
          const now = performance.now();
          pinchRef.current = {
            active: true,
            mode: 'undecided',
            lastCenterX: metrics.centerX,
            lastDistance: metrics.distance,
            lastTs: now,
            panVelocityPxMs: 0,
          };
          return;
        }

        const now = performance.now();
        const dt = Math.max(1, now - pinch.lastTs);
        const dx = metrics.centerX - pinch.lastCenterX;
        const rawZoomFactor =
          pinch.lastDistance > 1 && metrics.distance > 1
            ? pinch.lastDistance / metrics.distance
            : 1;
        const relDistanceDelta = Math.abs(1 - rawZoomFactor);
        const centerShift = Math.abs(dx);

        if (pinch.mode === 'undecided') {
          if (relDistanceDelta > 0.02) {
            pinch.mode = 'pinch';
            pinch.panVelocityPxMs = 0;
          } else if (centerShift > 3) {
            pinch.mode = 'pan';
          }
        }

        if (pinch.mode === 'pan') {
          if (Math.abs(dx) > 0.001) {
            panByPixels(-dx);
            const velocityPxMs = (dx * panDampingRef.current * (mirroredRef.current ? -1 : 1)) / dt;
            pinch.panVelocityPxMs = pinch.panVelocityPxMs * 0.35 + velocityPxMs * 0.65;
          } else {
            pinch.panVelocityPxMs *= 0.85;
          }
        }

        if (pinch.mode === 'pinch') {
          if (relDistanceDelta > 0.001) {
            // Keep pinch responsive but stable with bounded per-frame log-step.
            const dampedFactor = 1 + (rawZoomFactor - 1) * PINCH_ZOOM_DAMPING;
            const factor = clamp(dampedFactor, PINCH_ZOOM_MIN_FACTOR, PINCH_ZOOM_MAX_FACTOR);
            const rect = event.currentTarget.getBoundingClientRect();
            const anchorPx = metrics.centerX - rect.left;
            const logDelta = Math.log(factor) * 2.35;
            zoomByLogDelta(logDelta, anchorPx);
          }
        }

        pinchRef.current.lastCenterX = metrics.centerX;
        pinchRef.current.lastDistance = metrics.distance;
        pinchRef.current.lastTs = now;
        return;
      }

      const drag = dragRef.current;
      if (!drag.active || drag.pointerId !== event.pointerId) {
        return;
      }

      const now = performance.now();
      const dx = event.clientX - drag.lastX;
      const dt = Math.max(1, now - drag.lastTs);

      // A mouse drag sets the centre directly rather than through panByPixels,
      // so the mirrored view has to be honoured here too (and the velocity this
      // leaves for the inertia carries the same sign).
      const adjustedDx = dx * panDampingRef.current * (mirroredRef.current ? -1 : 1);
      drag.velocityPxMs = adjustedDx / dt;
      drag.lastX = event.clientX;
      drag.lastTs = now;

      const nextCenter = centerRef.current - adjustedDx * bpPerPxRef.current;
      scheduleCenter(clampCenter(nextCenter, bpPerPxRef.current, true));
    },
    [clampCenter, panByPixels, scheduleCenter, zoomByLogDelta],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') {
        const previousPinch = pinchRef.current;
        const touchDrag = touchDragRef.current;
        const releasedPan = touchDrag.pointerId === event.pointerId && touchDrag.axis === 'pan';
        const releasedVelocity = touchDrag.velocityPxMs;
        if (touchDrag.pointerId === event.pointerId) {
          touchDragRef.current = { ...IDLE_TOUCH_DRAG };
        }
        touchPointsRef.current.delete(event.pointerId);

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

        const metrics = touchMetrics(touchPointsRef.current);
        if (metrics) {
          const now = performance.now();
          pinchRef.current = {
            active: true,
            mode: 'undecided',
            lastCenterX: metrics.centerX,
            lastDistance: metrics.distance,
            lastTs: now,
            panVelocityPxMs: 0,
          };
        } else {
          pinchRef.current = {
            active: false,
            mode: 'undecided',
            lastCenterX: 0,
            lastDistance: 0,
            lastTs: 0,
            panVelocityPxMs: 0,
          };

          if (releasedPan && Math.abs(releasedVelocity) > TOUCH_PAN_MIN_RELEASE_VELOCITY_PX_MS) {
            startInertia(-releasedVelocity * bpPerPxRef.current * TOUCH_PAN_RELEASE_GAIN);
          } else if (
            previousPinch.mode === 'pan' &&
            Math.abs(previousPinch.panVelocityPxMs) > TOUCH_PAN_MIN_RELEASE_VELOCITY_PX_MS
          ) {
            const velocityBpMs =
              -previousPinch.panVelocityPxMs * bpPerPxRef.current * TOUCH_PAN_RELEASE_GAIN;
            startInertia(velocityBpMs);
          }
        }
        return;
      }

      const drag = dragRef.current;
      if (!drag.active || drag.pointerId !== event.pointerId) {
        return;
      }

      drag.active = false;
      drag.pointerId = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const velocityBpMs = -drag.velocityPxMs * bpPerPxRef.current * PAN_RELEASE_GAIN;
      startInertia(velocityBpMs);
    },
    [startInertia],
  );

  // Zoom in/out one wheel step, anchored under the cursor. `deltaY` is normalized
  // for line/page wheel modes so the feel is consistent across mice and trackpads.
  const zoomByWheel = useCallback(
    (deltaY: number, deltaMode: number, anchorPx: number) => {
      const normalizedDeltaY =
        deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * Math.max(1, widthPx) : deltaY;
      const rawLogDelta = clamp(
        normalizedDeltaY * WHEEL_ZOOM_DELTA_SCALE,
        -WHEEL_ZOOM_DELTA_CLAMP,
        WHEEL_ZOOM_DELTA_CLAMP,
      );
      zoomByLogDelta(rawLogDelta, anchorPx);
    },
    [widthPx, zoomByLogDelta],
  );

  useEffect(() => {
    centerRef.current = centerBp;
  }, [centerBp]);

  useEffect(() => {
    bpPerPxRef.current = bpPerPx;
  }, [bpPerPx]);

  useEffect(() => {
    panDampingRef.current = clamp(panDamping, 0.1, 1);
  }, [panDamping]);

  useEffect(() => {
    if (lastResetTokenRef.current === resetToken) {
      return;
    }
    lastResetTokenRef.current = resetToken;

    stopInertia();
    stopZoomInertia();
    clearTouchGesture();
    dragRef.current.active = false;
    dragRef.current.pointerId = null;

    const zoomBounds = getZoomBounds();
    const initialZoom = clamp(initialBpPerPx, zoomBounds.min, zoomBounds.max);
    setZoom(initialZoom);
    setCenter(clampCenter(initialCenterBp, initialZoom));
  }, [
    clampCenter,
    clearTouchGesture,
    getZoomBounds,
    initialBpPerPx,
    initialCenterBp,
    resetToken,
    setCenter,
    setZoom,
    stopInertia,
    stopZoomInertia,
  ]);

  useEffect(() => {
    const zoomBounds = getZoomBounds();
    const nextZoom = clamp(bpPerPxRef.current, zoomBounds.min, zoomBounds.max);
    if (Math.abs(nextZoom - bpPerPxRef.current) > 1e-9) {
      setZoom(nextZoom);
    }

    const nextCenter = clampCenter(centerRef.current, nextZoom);
    if (Math.abs(nextCenter - centerRef.current) > 1e-6) {
      setCenter(nextCenter);
    }
  }, [clampCenter, getZoomBounds, setCenter, setZoom]);

  useEffect(() => {
    return () => {
      stopInertia();
      stopZoomInertia();
    };
  }, [stopInertia, stopZoomInertia]);

  const range = useMemo(() => toRange(centerBp, bpPerPx, Math.max(1, widthPx)), [bpPerPx, centerBp, widthPx]);

  return {
    centerBp,
    bpPerPx,
    range,
    onPointerDown,
    onPointerMove,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    zoomByWheel,
    panByPixels,
    zoomByFactor: zoomAround,
    jumpToCenter,
    setExactBpPerPx,
  };
}
