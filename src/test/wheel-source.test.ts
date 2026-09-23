import { describe, expect, it } from 'vitest';
import {
  WHEEL_GESTURE_IDLE_MS,
  classifyWheelSource,
  resolveGestureSource,
} from '../lib/wheelSource';

describe('classifyWheelSource', () => {
  it('treats line/page delta modes as a physical wheel (Firefox)', () => {
    expect(classifyWheelSource({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe('mouse');
    expect(classifyWheelSource({ deltaX: 0, deltaY: -1, deltaMode: 2 })).toBe('mouse');
  });

  it('treats whole legacy detents as a physical wheel (Chromium/WebKit)', () => {
    // macOS Chrome, one notch: deltaY 40, wheelDeltaY -120.
    expect(classifyWheelSource({ deltaX: 0, deltaY: 40, deltaMode: 0, wheelDeltaY: -120 })).toBe('mouse');
    // Windows Chrome, one notch: deltaY 100, wheelDeltaY -120.
    expect(classifyWheelSource({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 })).toBe('mouse');
    // Several notches at once.
    expect(classifyWheelSource({ deltaX: 0, deltaY: 200, deltaMode: 0, wheelDeltaY: -360 })).toBe('mouse');
  });

  it('treats fractional momentum deltas as a touchpad', () => {
    expect(classifyWheelSource({ deltaX: 0, deltaY: 7.5, deltaMode: 0, wheelDeltaY: -22.5 })).toBe('trackpad');
    expect(classifyWheelSource({ deltaX: 0, deltaY: -0.25, deltaMode: 0 })).toBe('trackpad');
  });

  it('treats horizontal drift during a vertical glide as a touchpad', () => {
    // Two-finger scroll almost never stays perfectly axis-aligned.
    expect(classifyWheelSource({ deltaX: 2, deltaY: 48, deltaMode: 0, wheelDeltaY: -144 })).toBe('trackpad');
  });

  it('treats small clean integer steps as a touchpad', () => {
    expect(classifyWheelSource({ deltaX: 0, deltaY: 8, deltaMode: 0 })).toBe('trackpad');
    expect(classifyWheelSource({ deltaX: 0, deltaY: -12, deltaMode: 0, wheelDeltaY: -36 })).toBe('trackpad');
  });

  it('falls back to magnitude when no legacy delta is available', () => {
    expect(classifyWheelSource({ deltaX: 0, deltaY: 120, deltaMode: 0 })).toBe('mouse');
    expect(classifyWheelSource({ deltaX: 0, deltaY: 10, deltaMode: 0 })).toBe('trackpad');
  });
});

describe('resolveGestureSource', () => {
  const trackpadSample = { deltaX: 0, deltaY: 6.25, deltaMode: 0 };
  const mouseSample = { deltaX: 0, deltaY: 120, deltaMode: 0, wheelDeltaY: -360 };

  it('classifies fresh gestures from the sample', () => {
    expect(resolveGestureSource(null, mouseSample, 1_000)).toBe('mouse');
    expect(resolveGestureSource(null, trackpadSample, 1_000)).toBe('trackpad');
  });

  it('holds the latched source through a stray mid-gesture sample', () => {
    // A touchpad glide can momentarily produce a clean large integer; without the
    // latch the view would flip from scrolling to zooming mid-scroll.
    const latch = { source: 'trackpad' as const, lastEventAt: 1_000 };
    expect(resolveGestureSource(latch, mouseSample, 1_000 + WHEEL_GESTURE_IDLE_MS - 1)).toBe('trackpad');
  });

  it('reclassifies once the gesture goes quiet', () => {
    const latch = { source: 'trackpad' as const, lastEventAt: 1_000 };
    expect(resolveGestureSource(latch, mouseSample, 1_000 + WHEEL_GESTURE_IDLE_MS)).toBe('mouse');
  });
});
