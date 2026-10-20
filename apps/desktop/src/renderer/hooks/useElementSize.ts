import { useEffect, useState, type RefCallback } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

const ZERO: ElementSize = { width: 0, height: 0 };

/**
 * Content-box size of an element, kept up to date with a ResizeObserver (window resizes,
 * fullscreen, the strip appearing). Attach the returned callback ref; 0 × 0 until measured.
 */
export function useElementSize<T extends HTMLElement>(): [RefCallback<T>, ElementSize] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>(ZERO);

  useEffect(() => {
    if (!element) return;
    // Fires once right away with the current size, then on every change.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, element ? size : ZERO];
}
