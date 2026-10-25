/**
 * What the stage shows and in which order, from what the user watches. Pure so every branch can
 * be unit-tested; `components/Workspace.tsx` computes it once (the M hotkey and the header's
 * pop-out button use `effectiveFocus`) and `components/Stage.tsx` renders it.
 *
 * - A stream in destaque: big on the stage; the strip holds your previews, the other watched
 *   streams as mini tiles (webcams included) and the cards of unwatched streams.
 * - One watched stream: big on the stage, without "Voltar à grade".
 * - Two or more: the 2-column grid (plus the "Transmitir" slot when the count is odd); the strip
 *   holds your previews and the cards.
 * - Nothing watched: your screen preview on the stage, else your camera preview, else the
 *   cards, else the empty state.
 *
 * Streams another window shows (`elsewhereKeys`: the screen in the pop-out, the cameras in the
 * picture-in-picture) keep their place but are rendered as a notice instead of the video.
 * Fullscreen hides the strip.
 */
import type { StreamKind } from './streamKey';

export interface StageLayoutInput {
  /** Every remote stream published in the room (screens and webcams), in room order. */
  liveKeys: readonly string[];
  /** Watched stream keys, in the order they were picked (may lag behind `liveKeys`). */
  watchedKeys: readonly string[];
  /** The stream in destaque; null = the grid. */
  focusedKey: string | null;
  /** Watched streams shown by another window of this app. */
  elsewhereKeys: readonly string[];
  /** Your screen share is live (its preview exists). */
  localScreen: boolean;
  /** Your webcam is on (its preview exists). */
  localCamera: boolean;
  fullscreen: boolean;
  /**
   * This client can share its screen (`capabilities.screenShare`): the free cell of an odd grid
   * offers "Transmitir". Default true; the web client has no slot.
   */
  canStream?: boolean;
}

export interface WatchedTile {
  key: string;
  /** Shown by another window: a notice with "Trazer de volta" instead of the video. */
  elsewhere: boolean;
}

export type StageMain =
  /** One watched stream big on the stage. */
  | { kind: 'focus'; tile: WatchedTile }
  /** 2+ watched streams side by side; `slot` = odd count, the free cell offers "Transmitir". */
  | { kind: 'grid'; tiles: WatchedTile[]; slot: boolean }
  /** Your own preview, when nothing is watched. */
  | { kind: 'local'; source: StreamKind }
  /** The cards of the unwatched streams (`StageLayout.cards`). */
  | { kind: 'cards' }
  | { kind: 'empty' };

export type StripItem =
  | { kind: 'local'; source: StreamKind }
  | { kind: 'mini'; tile: WatchedTile }
  | { kind: 'card'; key: string };

export interface StageLayout {
  main: StageMain;
  /** Below the stage; empty in fullscreen. */
  strip: StripItem[];
  /** Published streams nobody picked, in room order (cards without video). */
  cards: string[];
  /**
   * The stream big on the stage and playing in this window (not elsewhere), or null on the
   * grid: the M hotkey and the header's pop-out button act on it.
   */
  effectiveFocus: string | null;
  /** In destaque with 2+ watched streams: "Voltar à grade" is offered (button, menu, Esc). */
  canShowGrid: boolean;
}

export function computeStageLayout(input: StageLayoutInput): StageLayout {
  const canStream = input.canStream ?? true;
  const live = new Set(input.liveKeys);
  const watched = new Set(input.watchedKeys);
  const elsewhere = new Set(input.elsewhereKeys);
  const tileOf = (key: string): WatchedTile => ({ key, elsewhere: elsewhere.has(key) });
  // Watched streams that are still published, in the order they were picked.
  const liveWatched = input.watchedKeys.filter((key) => live.has(key));
  const cards = input.liveKeys.filter((key) => !watched.has(key));
  const cardItems: StripItem[] = cards.map((key) => ({ kind: 'card', key }));

  const locals: StripItem[] = [];
  if (input.localScreen) locals.push({ kind: 'local', source: 'screen' });
  if (input.localCamera) locals.push({ kind: 'local', source: 'camera' });

  let main: StageMain;
  let strip: StripItem[];
  let canShowGrid = false;
  const focused =
    input.focusedKey !== null && liveWatched.includes(input.focusedKey) ? input.focusedKey : null;

  if (focused !== null) {
    main = { kind: 'focus', tile: tileOf(focused) };
    const minis: StripItem[] = liveWatched
      .filter((key) => key !== focused)
      .map((key) => ({ kind: 'mini', tile: tileOf(key) }));
    strip = [...locals, ...minis, ...cardItems];
    canShowGrid = liveWatched.length >= 2;
  } else if (liveWatched.length === 1 && liveWatched[0] !== undefined) {
    main = { kind: 'focus', tile: tileOf(liveWatched[0]) };
    strip = [...locals, ...cardItems];
  } else if (liveWatched.length >= 2) {
    main = {
      kind: 'grid',
      tiles: liveWatched.map(tileOf),
      slot: canStream && liveWatched.length % 2 === 1,
    };
    strip = [...locals, ...cardItems];
  } else if (input.localScreen) {
    main = { kind: 'local', source: 'screen' };
    strip = input.localCamera ? [{ kind: 'local', source: 'camera' }, ...cardItems] : cardItems;
  } else if (input.localCamera) {
    main = { kind: 'local', source: 'camera' };
    strip = cardItems;
  } else if (cards.length > 0) {
    main = { kind: 'cards' };
    strip = [];
  } else {
    main = { kind: 'empty' };
    strip = [];
  }

  const effectiveFocus = main.kind === 'focus' && !main.tile.elsewhere ? main.tile.key : null;
  return { main, strip: input.fullscreen ? [] : strip, cards, effectiveFocus, canShowGrid };
}
