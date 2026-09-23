import { useMemo } from 'react';
import { percentileOfValue } from '../lib/signalDistribution';

type SignalContextStripProps = {
  /** Quantile ladder of same-span window maxima; see buildWindowMaxLadder. */
  ladder: Float32Array;
  /** Auto-scale maximum currently drawn on this track. */
  viewMax: number;
  heightPx: number;
};

const SLICES = 34;
const WIDTH_PX = 12;

/**
 * A miniature genome-wide value distribution drawn on the track's own value axis,
 * with the currently displayed range shaded. Local auto-scaling makes every region
 * look equally tall; this restores the absolute sense of scale.
 *
 * The value axis is log-scaled because signal data is heavy-tailed — on a linear
 * axis nearly all the mass collapses onto the bottom pixel.
 */
export function SignalContextStrip({ ladder, viewMax, heightPx }: SignalContextStripProps) {
  const height = Math.max(18, heightPx);
  const topValue = ladder[ladder.length - 1];

  const shape = useMemo(() => {
    if (!(topValue > 0)) {
      return null;
    }

    const logTop = Math.log1p(topValue);
    const valueAtY = (y: number) => Math.expm1((1 - y / height) * logTop);
    const yForValue = (value: number) =>
      height * (1 - Math.min(1, Math.max(0, Math.log1p(Math.max(0, value)) / logTop)));

    // Weight per slice is the share of covered bases whose value falls in that band,
    // read straight off the quantile ladder.
    const weights: number[] = [];
    let peak = 0;
    for (let slice = 0; slice < SLICES; slice += 1) {
      const yTop = (slice / SLICES) * height;
      const yBottom = ((slice + 1) / SLICES) * height;
      const upper = percentileOfValue(ladder, valueAtY(yTop));
      const lower = percentileOfValue(ladder, valueAtY(yBottom));
      const weight = Number.isFinite(upper) && Number.isFinite(lower) ? Math.max(0, upper - lower) : 0;
      weights.push(weight);
      peak = Math.max(peak, weight);
    }

    if (peak <= 0) {
      return null;
    }

    // sqrt keeps thin tails visible next to the dominant near-zero mass.
    const points = weights.map((weight, slice) => {
      const y = ((slice + 0.5) / SLICES) * height;
      const width = Math.max(0.6, Math.sqrt(weight / peak) * (WIDTH_PX - 1));
      return { y, width };
    });

    const path = [
      `M 0 ${height.toFixed(1)}`,
      ...points.map((point) => `L ${point.width.toFixed(2)} ${point.y.toFixed(1)}`),
      `L 0 0`,
      'Z',
    ].join(' ');

    return { path, markerY: yForValue(viewMax) };
  }, [ladder, height, topValue, viewMax]);

  if (!shape) {
    return null;
  }

  return (
    <svg
      className="track-context-strip"
      width={WIDTH_PX}
      height={height}
      viewBox={`0 0 ${WIDTH_PX} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <path className="track-context-density" d={shape.path} />
      {/* Everything the current view can show sits below this line. */}
      <rect
        className="track-context-window"
        x={0}
        y={shape.markerY}
        width={WIDTH_PX}
        height={Math.max(0, height - shape.markerY)}
      />
      <line
        className="track-context-marker"
        x1={0}
        x2={WIDTH_PX}
        y1={shape.markerY}
        y2={shape.markerY}
      />
    </svg>
  );
}
