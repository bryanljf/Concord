import { useLayoutEffect, useRef, useState } from 'react';
import { marqueeKeyframes } from '../../lib/marquee';
import '../../styles/marquee.css';

interface MarqueeProps {
  text: string;
  className?: string;
  /** Element used for the line (keeps the caller's semantics: `p`, `strong`, `span`). */
  as?: 'p' | 'span' | 'strong';
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** Rounding noise between the text's layout width and its box; anything above is overflow. */
const OVERFLOW_EPSILON_PX = 0.5;

/**
 * One line of text that never wraps: when it does not fit, it slides to its end, waits, and
 * glides slowly back to the start, over and over (like Spotify's long titles). Fits → plain
 * text. With reduced motion it stays put and ends in an ellipsis.
 */
export function Marquee({ text, className, as: Tag = 'span' }: MarqueeProps) {
  const outer = useRef<HTMLElement | null>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  // How far the text sticks out (sub-pixel widths: any real overflow counts), re-measured when
  // the text or the available width changes, when the fonts finish loading and when the window
  // shows again (a covered window skips layout callbacks, so sizes can go stale meanwhile).
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    const measure = (): void => {
      const sticking = content.getBoundingClientRect().width - box.clientWidth;
      setOverflow(sticking > OVERFLOW_EPSILON_PX ? Math.ceil(sticking) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') measure();
    };
    document.addEventListener('visibilitychange', onVisible);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) measure();
    });
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [text]);

  useLayoutEffect(() => {
    const content = inner.current;
    if (!content || overflow === 0) return;
    if (window.matchMedia(REDUCED_MOTION).matches) return;
    const { keyframes, duration } = marqueeKeyframes(overflow);
    const animation = content.animate(keyframes, { duration, iterations: Infinity });
    return () => animation.cancel();
  }, [overflow, text]);

  const classes = ['marquee', overflow > 0 ? 'marquee--overflow' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <Tag
      ref={(element: HTMLElement | null) => void (outer.current = element)}
      className={classes}
      title={text}
    >
      <span ref={inner} className="marquee__text">
        {text}
      </span>
    </Tag>
  );
}
