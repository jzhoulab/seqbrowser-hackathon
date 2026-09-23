import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  type GenomicRange,
  clamp,
  formatRange,
  niceStep,
} from '../lib/genomeMath';
import { useElementWidth } from '../hooks/useElementWidth';
import { trackDataLoader } from '../data/trackDataLoader';
import {
  NAVIGATOR_FLANK_BP,
  navigatorWindow,
  snapWindowToGrid,
  type NavigatorWindow,
} from '../lib/navigatorWindow';
import { getViewportPalette, isViewportDark, subscribeViewportTheme } from '../lib/viewportTheme';
import type { DataWindowSpec, IdeogramBand, TrackFeature, TrackSpec, TrackWindowData } from '../types';

type NavigatorOption = {
  id: string;
  label: string;
};

type BrushNavigatorProps = {
  chr: string;
  chrLength: number;
  range: GenomicRange;
  navigatorTrackId: string;
  navigatorOptions: NavigatorOption[];
  onNavigatorTrackChange: (nextTrackId: string) => void;
  overviewTrack: TrackSpec | null;
  ideogramBands: IdeogramBand[] | null;
  ideogramAssembly: string | null;
  resolutionScale: number;
  onRangeChange: (nextStart: number, nextEnd: number) => void;
};

type DragMode = 'move' | 'resize-left' | 'resize-right' | 'recenter';

type DragState = {
  active: boolean;
  pointerId: number | null;
  mode: DragMode;
  offsetPx: number;
};

function hash32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function drawOverview(
  canvas: HTMLCanvasElement,
  widthPx: number,
  heightPx: number,
  chr: string,
  navWindow: NavigatorWindow,
  overviewTrack: TrackSpec | null,
  features: TrackFeature[] | null,
  ideogramBands: IdeogramBand[] | null,
) {
  const windowSpan = Math.max(1, navWindow.end - navWindow.start);
  const toPx = (bp: number) => ((bp - navWindow.start) / windowSpan) * widthPx;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(widthPx * dpr);
  canvas.height = Math.round(heightPx * dpr);
  canvas.style.width = `${widthPx}px`;
  canvas.style.height = `${heightPx}px`;
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, widthPx, heightPx);
  const palette = getViewportPalette();
  context.fillStyle = palette.navBg;
  context.fillRect(0, 0, widthPx, heightPx);

  if (!overviewTrack) {
    if (ideogramBands && ideogramBands.length > 0) {
      const visible = ideogramBands.filter(
        (band) => band.end > navWindow.start && band.start < navWindow.end,
      );

      for (const band of visible) {
        const left = toPx(Math.max(band.start, navWindow.start));
        const right = toPx(Math.min(band.end, navWindow.end));
        context.fillStyle = colorForStain(band.stain);
        context.fillRect(left, 0, Math.max(1, right - left), heightPx);
      }

      // A 200 kb window usually sits inside a single cytoband, which would
      // otherwise paint as one flat rectangle: name the band so the strip still
      // answers "where am I".
      context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = palette.inkSoft;
      for (const band of visible) {
        const left = toPx(Math.max(band.start, navWindow.start));
        const right = toPx(Math.min(band.end, navWindow.end));
        const width = right - left;
        if (width < context.measureText(band.name).width + 12) {
          continue;
        }
        context.fillText(band.name, left + width / 2, heightPx / 2);
      }
      return;
    }

    // Synthetic fallback for unsupported assemblies.
    let position = 0;
    let idx = 0;
    const seed = hash32(`${chr}|${navWindow.start}`);
    while (position < windowSpan) {
      const nextSeed = hash32(`${seed}|${idx}`);
      const span = 20_000 + (nextSeed % 60_000);
      const next = Math.min(windowSpan, position + span);
      const left = (position / windowSpan) * widthPx;
      const right = (next / windowSpan) * widthPx;
      const synthetic = palette.navSynthetic;
      context.fillStyle = synthetic[nextSeed % synthetic.length] ?? synthetic[0];
      context.fillRect(left, 0, Math.max(1, right - left), heightPx);
      position = next;
      idx += 1;
    }
    return;
  }

  if (!features || features.length === 0) {
    return;
  }

  const binCount = Math.max(1, Math.floor(widthPx));
  const bins = new Float32Array(binCount);
  let maxValue = 0;
  // Over ~200 kb an annotation track returns individual transcripts, whose
  // bigBed score is usually 0 -- a score profile would draw nothing. Their
  // useful summary at this scale is how many of them cover each pixel.
  const stackFeatures = overviewTrack.kind === 'annotation';
  for (const feature of features) {
    if (feature.end <= navWindow.start || feature.start >= navWindow.end) {
      continue;
    }

    const startBin = clamp(
      Math.floor(((feature.start - navWindow.start) / windowSpan) * binCount),
      0,
      binCount - 1,
    );
    const endBinExclusive = clamp(
      Math.ceil(((feature.end - navWindow.start) / windowSpan) * binCount),
      1,
      binCount,
    );
    const boundedEnd = endBinExclusive <= startBin ? Math.min(binCount, startBin + 1) : endBinExclusive;
    const score = Math.max(0, feature.score);

    for (let index = startBin; index < boundedEnd; index += 1) {
      bins[index] = stackFeatures ? bins[index] + 1 : Math.max(bins[index], score);
      if (bins[index] > maxValue) {
        maxValue = bins[index];
      }
    }
  }

  if (maxValue <= 0) {
    return;
  }

  context.fillStyle = `${overviewTrack.color}66`;
  context.beginPath();
  context.moveTo(0, heightPx - 2);
  for (let x = 0; x < binCount; x += 1) {
    const normalized = bins[x] / maxValue;
    const y = heightPx - 3 - normalized * (heightPx - 9);
    context.lineTo(x, y);
  }
  context.lineTo(binCount, heightPx - 2);
  context.closePath();
  context.fill();
}

function colorForStain(stain: string): string {
  const { navStain } = getViewportPalette();
  return navStain[stain.toLowerCase()] ?? navStain.default;
}


export function BrushNavigator({
  chr,
  chrLength,
  range,
  navigatorTrackId,
  navigatorOptions,
  onNavigatorTrackChange,
  overviewTrack,
  ideogramBands,
  ideogramAssembly,
  resolutionScale,
  onRangeChange,
}: BrushNavigatorProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const widthPx = useElementWidth(host);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dark = useSyncExternalStore(subscribeViewportTheme, isViewportDark, isViewportDark);
  const [overviewState, setOverviewState] = useState<{
    key: string | null;
    data: TrackWindowData | null;
    error: string | null;
  }>({
    key: null,
    data: null,
    error: null,
  });
  const dragRef = useRef<DragState>({
    active: false,
    pointerId: null,
    mode: 'move',
    offsetPx: 0,
  });
  const minSelectionPx = 12;

  // The window tracks the viewport, so dragging the selection would otherwise
  // drag the ground it stands on -- the brush could never leave the middle.
  // Freezing it for the duration of a gesture makes the strip behave like a map.
  const [frozenWindow, setFrozenWindow] = useState<NavigatorWindow | null>(null);
  const liveWindow = useMemo(
    () => navigatorWindow(range, chrLength),
    [chrLength, range],
  );
  const activeWindow = frozenWindow ?? liveWindow;
  const windowSpan = Math.max(1, activeWindow.end - activeWindow.start);

  const overviewSpec: DataWindowSpec | null = useMemo(() => {
    if (!overviewTrack || widthPx <= 0) {
      return null;
    }

    const normalizedResolutionScale = Number.isFinite(resolutionScale)
      ? Math.max(0.1, resolutionScale)
      : 2.4;
    const request = snapWindowToGrid(activeWindow, chrLength);
    const requestSpan = Math.max(1, request.end - request.start);
    const resolutionBp = Math.max(1, niceStep((requestSpan / Math.max(1, widthPx)) * normalizedResolutionScale));
    return {
      key: `nav:${chr}:${request.start}:${request.end}:r${resolutionBp}:${overviewTrack.id}`,
      requestStart: request.start,
      requestEnd: request.end,
      resolutionBp,
    };
  }, [activeWindow, chr, chrLength, overviewTrack, resolutionScale, widthPx]);

  const selectionStartPx = ((range.start - activeWindow.start) / windowSpan) * Math.max(1, widthPx);
  const selectionEndPx = ((range.end - activeWindow.start) / windowSpan) * Math.max(1, widthPx);
  const selectionWidthPx = Math.max(minSelectionPx, selectionEndPx - selectionStartPx);

  useEffect(() => {
    if (!overviewTrack || !overviewSpec) {
      return;
    }

    const controller = new AbortController();
    let stale = false;
    trackDataLoader
      .getWindow(overviewTrack, chr, overviewSpec, controller.signal)
      .then((data) => {
        if (stale) {
          return;
        }
        setOverviewState({
          key: overviewSpec.key,
          data,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (stale) {
          return;
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setOverviewState({
          key: overviewSpec.key,
          data: null,
          error: error instanceof Error ? error.message : 'Navigator load failed',
        });
      });

    return () => {
      stale = true;
      controller.abort();
    };
  }, [chr, overviewSpec, overviewTrack]);

  useEffect(() => {
    if (!canvasRef.current || widthPx <= 0) {
      return;
    }

    const features = overviewSpec && overviewState.key === overviewSpec.key ? overviewState.data?.features ?? null : null;
    drawOverview(canvasRef.current, widthPx, 40, chr, activeWindow, overviewTrack, features, ideogramBands);
    // `dark` is a dependency so the navigator repaints when the theme flips.
  }, [activeWindow, chr, dark, ideogramBands, overviewSpec, overviewState.data, overviewState.key, overviewTrack, widthPx]);

  const activeOverviewError =
    overviewTrack && overviewSpec && overviewState.key === overviewSpec.key ? overviewState.error : null;

  const writeRangeByPixels = (startPx: number, endPx: number) => {
    if (widthPx <= 0) {
      return;
    }
    const clampedStartPx = clamp(startPx, 0, widthPx);
    const clampedEndPx = clamp(endPx, clampedStartPx + minSelectionPx, widthPx);
    const nextStart = activeWindow.start + (clampedStartPx / widthPx) * windowSpan;
    const nextEnd = activeWindow.start + (clampedEndPx / widthPx) * windowSpan;
    onRangeChange(nextStart, nextEnd);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !host || widthPx <= 0) {
      return;
    }
    event.preventDefault();

    const rect = host.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, widthPx);
    const left = selectionStartPx;
    const right = left + selectionWidthPx;
    const nearLeft = Math.abs(x - left) <= 10;
    const nearRight = Math.abs(x - right) <= 10;
    const inside = x >= left && x <= right;

    let mode: DragMode = 'recenter';
    let offsetPx = 0;
    if (nearLeft) {
      mode = 'resize-left';
    } else if (nearRight) {
      mode = 'resize-right';
    } else if (inside) {
      mode = 'move';
      offsetPx = x - left;
    }

    if (mode === 'recenter') {
      const half = selectionWidthPx * 0.5;
      const startPx = clamp(x - half, 0, Math.max(0, widthPx - selectionWidthPx));
      writeRangeByPixels(startPx, startPx + selectionWidthPx);
    }

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      mode,
      offsetPx,
    };
    setFrozenWindow(activeWindow);
    host.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId || !host || widthPx <= 0) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, widthPx);
    const left = selectionStartPx;
    const right = left + selectionWidthPx;

    if (drag.mode === 'move' || drag.mode === 'recenter') {
      const startPx = clamp(x - drag.offsetPx, 0, Math.max(0, widthPx - selectionWidthPx));
      writeRangeByPixels(startPx, startPx + selectionWidthPx);
      return;
    }

    if (drag.mode === 'resize-left') {
      const startPx = clamp(x, 0, right - minSelectionPx);
      writeRangeByPixels(startPx, right);
      return;
    }

    const endPx = clamp(x, left + minSelectionPx, widthPx);
    writeRangeByPixels(left, endPx);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId || !host) {
      return;
    }
    dragRef.current = { active: false, pointerId: null, mode: 'move', offsetPx: 0 };
    setFrozenWindow(null);
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section className="brush-wrap">
      <div className="brush-meta">
        <span>
          {chr.toUpperCase()} navigator · ±{Math.round(NAVIGATOR_FLANK_BP / 1000)} kb
          {overviewTrack ? ` · ${overviewTrack.name}` : ` · ideogram${ideogramAssembly ? ` (${ideogramAssembly})` : ''}`}
        </span>
        <div className="brush-controls">
          <label className="brush-source">
            <span>source</span>
            <select
              value={navigatorTrackId}
              onChange={(event) => onNavigatorTrackChange(event.target.value)}
            >
              {navigatorOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <span className="brush-range">
            {formatRange(activeWindow.start, activeWindow.end)}
          </span>
        </div>
      </div>
      <div
        className="brush-track"
        ref={setHost}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <canvas className="brush-canvas" ref={canvasRef} />
        {activeOverviewError ? <span className="brush-error">{activeOverviewError}</span> : null}
        <span
          className="brush-selection"
          style={{
            left: `${(selectionStartPx / Math.max(1, widthPx)) * 100}%`,
            width: `${(selectionWidthPx / Math.max(1, widthPx)) * 100}%`,
          }}
        >
          <span className="brush-handle left" />
          <span className="brush-handle right" />
        </span>
      </div>
    </section>
  );
}
