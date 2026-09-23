import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clamp, formatBp, type GenomicRange } from '../lib/genomeMath';
import { useElementWidth } from '../hooks/useElementWidth';

type IdeogramBarProps = {
  chr: string;
  chrLength: number;
  range: GenomicRange;
  onJumpCenter: (centerBp: number) => void;
};

type DragState = {
  active: boolean;
  pointerId: number | null;
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

function buildBands(chr: string, chrLength: number): Array<{ start: number; end: number; shade: string }> {
  const bands: Array<{ start: number; end: number; shade: string }> = [];
  const baseSeed = hash32(chr);
  let position = 0;
  let idx = 0;

  while (position < chrLength) {
    const seed = hash32(`${baseSeed}|${idx}`);
    const span = 3_500_000 + (seed % 10_000_000);
    const next = Math.min(chrLength, position + span);
    const shade = ['#f0f0f0', '#e6e6e6', '#dcdcdc', '#d2d2d2'][seed % 4];
    bands.push({ start: position, end: next, shade });
    position = next;
    idx += 1;
  }

  return bands;
}

export function IdeogramBar({ chr, chrLength, range, onJumpCenter }: IdeogramBarProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const widthPx = useElementWidth(host);
  const dragRef = useRef<DragState>({ active: false, pointerId: null, offsetPx: 0 });
  const bands = useMemo(() => buildBands(chr, chrLength), [chr, chrLength]);

  const windowStartPx = (range.start / chrLength) * Math.max(1, widthPx);
  const windowEndPx = (range.end / chrLength) * Math.max(1, widthPx);
  const windowWidthPx = Math.max(6, windowEndPx - windowStartPx);

  const jumpAtClientX = (clientX: number) => {
    if (!host || widthPx <= 0) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, widthPx);
    const centerBp = (x / widthPx) * chrLength;
    onJumpCenter(centerBp);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !host || widthPx <= 0) {
      return;
    }
    event.preventDefault();

    const rect = host.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, widthPx);
    const inWindow = x >= windowStartPx && x <= windowStartPx + windowWidthPx;
    if (!inWindow) {
      jumpAtClientX(event.clientX);
    }

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      offsetPx: inWindow ? x - windowStartPx : windowWidthPx * 0.5,
    };

    host.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId || !host || widthPx <= 0) {
      return;
    }

    const rect = host.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, widthPx);
    const nextStartPx = clamp(x - drag.offsetPx, 0, Math.max(0, widthPx - windowWidthPx));
    const centerBp = ((nextStartPx + windowWidthPx * 0.5) / widthPx) * chrLength;
    onJumpCenter(centerBp);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId || !host) {
      return;
    }
    dragRef.current = { active: false, pointerId: null, offsetPx: 0 };
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    dragRef.current = { active: false, pointerId: null, offsetPx: 0 };
  }, [chr, chrLength]);

  return (
    <section className="ideogram-wrap">
      <div className="ideogram-meta">
        <span>{chr.toUpperCase()}</span>
        <span>{formatBp(chrLength)} bp</span>
      </div>
      <div
        className="ideogram-track"
        ref={setHost}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {bands.map((band) => {
          const left = (band.start / chrLength) * 100;
          const width = ((band.end - band.start) / chrLength) * 100;
          return (
            <span
              className="ideogram-band"
              key={`${band.start}:${band.end}`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: band.shade,
              }}
            />
          );
        })}
        <span
          className="ideogram-window"
          style={{
            left: `${(windowStartPx / Math.max(1, widthPx)) * 100}%`,
            width: `${(windowWidthPx / Math.max(1, widthPx)) * 100}%`,
          }}
        />
      </div>
    </section>
  );
}
