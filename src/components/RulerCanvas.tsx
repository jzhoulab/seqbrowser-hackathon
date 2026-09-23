import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  type GenomicRange,
  clamp,
  clampRangeToChromosome,
  formatPosition,
  niceStep,
} from '../lib/genomeMath';
import { getViewportPalette, isViewportDark, subscribeViewportTheme } from '../lib/viewportTheme';
import { buildDisplayAxis, drawEditBands } from '../lib/displayAxis';
import type { SequenceEdit } from '../types';

type RulerCanvasProps = {
  widthPx: number;
  heightPx: number;
  bpPerPx: number;
  range: GenomicRange;
  chrLength: number;
  /** Minus strand: the ruler reads right-to-left, labels stay genomic. */
  reversed?: boolean;
  /** Insertions open unlabelled columns; the ruler follows the same axis as the tracks. */
  edits?: readonly SequenceEdit[];
};

export function RulerCanvas({
  widthPx,
  heightPx,
  bpPerPx,
  range,
  chrLength,
  reversed = false,
  edits,
}: RulerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dark = useSyncExternalStore(subscribeViewportTheme, isViewportDark, isViewportDark);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || widthPx <= 0 || heightPx <= 0) {
      return;
    }
    const palette = getViewportPalette();

    // Cap DPR: above 2x the extra pixels cost real rasterization time and are not
    // visible on a 1px-tick ruler.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetWidth = Math.round(widthPx * dpr);
    const targetHeight = Math.round(heightPx * dpr);

    // Assigning canvas.width/height reallocates and clears the backing store, so
    // only do it when the size actually changed — this effect reruns on every pan.
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.style.width = `${widthPx}px`;
      canvas.style.height = `${heightPx}px`;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const boundedRange = clampRangeToChromosome(range, chrLength);
    // The ruler draws through the same axis as every track: mirrored on the minus
    // strand, with a column for each inserted base. Labels are still genomic --
    // an inserted column owns no coordinate and gets no tick -- so a reader can
    // always take a position off the ruler and find it in a data track.
    const axis = buildDisplayAxis({
      startBp: boundedRange.start,
      endBp: boundedRange.end,
      widthPx,
      reversed,
      edits,
    });
    const tickStep = niceStep(bpPerPx * 110);
    const tickStepPx = tickStep / bpPerPx;
    const majorEvery = 5;
    const firstTickIndex = Math.floor(boundedRange.start / tickStep) - 1;
    const lastTickIndex = Math.ceil(boundedRange.end / tickStep) + 1;

    context.fillStyle = palette.bg;
    context.fillRect(0, 0, widthPx, heightPx);

    // Type and minor-tick inset scale with the strip so a short ruler keeps its
    // labels inside the canvas instead of clipping them.
    const labelFontPx = clamp(heightPx * 0.5, 9, 12);
    const minorTickTop = Math.max(3, heightPx * 0.35);
    context.font = `${labelFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    context.textBaseline = 'top';

    for (let tickIndex = firstTickIndex; tickIndex <= lastTickIndex; tickIndex += 1) {
      const tickBp = tickIndex * tickStep;
      const x = axis.xOfBp(tickBp);
      if (x < -tickStepPx || x > widthPx + tickStepPx) {
        continue;
      }

      // Keep major ticks tied to world coordinates (not loop index) so panning feels like a single sliding ruler.
      const mod = ((tickIndex % majorEvery) + majorEvery) % majorEvery;
      const isMajor = mod === 0;
      const xLine = Math.round(x) + 0.5;

      context.beginPath();
      context.moveTo(xLine, isMajor ? 0 : minorTickTop);
      context.lineTo(xLine, heightPx);
      context.strokeStyle = isMajor ? palette.gridStrong : palette.gridWeak;
      context.lineWidth = isMajor ? 1.2 : 1;
      context.stroke();

      if (isMajor && x > -64 && x < widthPx + 6) {
        context.fillStyle = palette.tickLabel;
        // On the minus strand the text hangs to the LEFT of its tick so it still
        // sits on the side the coordinates increase toward.
        if (reversed) {
          context.textAlign = 'right';
          context.fillText(formatPosition(tickBp), x - 4, 2);
          context.textAlign = 'left';
        } else {
          context.fillText(formatPosition(tickBp), x + 4, 2);
        }
      }
    }

    // Every edit, marked on the ruler too, so the marks on the tracks below have
    // a header: an inserted column carries no coordinate and is tinted rather
    // than left as a blank the eye reads as a missing tick.
    drawEditBands(context, axis, minorTickTop, heightPx - minorTickTop);
  }, [bpPerPx, chrLength, dark, edits, heightPx, range, reversed, widthPx]);

  return <canvas className="ruler-canvas" ref={canvasRef} />;
}
