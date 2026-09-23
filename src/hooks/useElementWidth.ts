import { useEffect, useState } from 'react';

export function useElementWidth(target: HTMLElement | null): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!target) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });

    observer.observe(target);
    return () => observer.disconnect();
  }, [target]);

  return width;
}
