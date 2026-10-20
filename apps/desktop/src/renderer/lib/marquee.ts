/**
 * Timing of the long-title marquee (`components/music/Marquee.tsx`): a pause at the start, a
 * slide to the end, a pause there, then a slower glide back. Pure so the timing can be tested.
 */

/** Slide towards the end, in pixels per second. */
export const MARQUEE_FORWARD_PX_S = 40;
/** The way back is slower ("volta lentamente ao início"). */
export const MARQUEE_BACK_PX_S = 20;
export const MARQUEE_START_PAUSE_MS = 1_800;
export const MARQUEE_END_PAUSE_MS = 1_200;

export interface MarqueeTimeline {
  keyframes: Keyframe[];
  /** One full cycle, in milliseconds. */
  duration: number;
}

/** Web Animations keyframes for text that sticks out by `overflow` pixels. */
export function marqueeKeyframes(overflow: number): MarqueeTimeline {
  const distance = Math.max(0, overflow);
  const forward = (distance / MARQUEE_FORWARD_PX_S) * 1000;
  const back = (distance / MARQUEE_BACK_PX_S) * 1000;
  const duration = MARQUEE_START_PAUSE_MS + forward + MARQUEE_END_PAUSE_MS + back;
  const at = (ms: number): number => ms / duration;
  const start = 'translateX(0)';
  const end = `translateX(${-distance}px)`;
  return {
    duration,
    keyframes: [
      { transform: start, offset: 0 },
      { transform: start, offset: at(MARQUEE_START_PAUSE_MS), easing: 'ease-in-out' },
      { transform: end, offset: at(MARQUEE_START_PAUSE_MS + forward) },
      {
        transform: end,
        offset: at(MARQUEE_START_PAUSE_MS + forward + MARQUEE_END_PAUSE_MS),
        easing: 'ease-in-out',
      },
      { transform: start, offset: 1 },
    ],
  };
}
