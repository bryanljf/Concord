/**
 * Pure helpers for the custom context menu (components/ContextMenu.tsx): the items offered on a
 * watched live, the keyboard shortcuts that open it, and keeping it inside the viewport.
 */

/** The live on the stage, or a watched live in the strip. */
export type WatchedTileKind = 'focused' | 'mini';

export type WatchMenuAction = 'focus' | 'popout' | 'mute' | 'unmute' | 'stop';

export interface WatchMenuItem {
  action: WatchMenuAction;
  /** pt-BR label shown in the menu. */
  label: string;
  /** Destructive look (red on hover). */
  danger?: boolean;
  /** Draws a divider above the item. */
  separatorBefore?: boolean;
}

/**
 * Items of the menu opened on a watched live. Only the focused live has audio, so mute is only
 * offered there; "Colocar em destaque" only makes sense for a mini tile. "Parar de assistir"
 * stays last, below a divider, like other destructive actions.
 */
export function watchMenuItems(kind: WatchedTileKind, muted: boolean): WatchMenuItem[] {
  const items: WatchMenuItem[] = [];
  if (kind === 'mini') items.push({ action: 'focus', label: 'Colocar em destaque' });
  items.push({ action: 'popout', label: 'Abrir em pop-out' });
  if (kind === 'focused') {
    items.push(
      muted ? { action: 'unmute', label: 'Ativar som' } : { action: 'mute', label: 'Silenciar' },
    );
  }
  items.push({ action: 'stop', label: 'Parar de assistir', danger: true, separatorBefore: true });
  return items;
}

export type LocalPreviewMenuAction = 'switch' | 'stop-broadcast';

export interface LocalPreviewMenuItem {
  action: LocalPreviewMenuAction;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

/** Items of the menu opened on your own broadcast preview. */
export function localPreviewMenuItems(): LocalPreviewMenuItem[] {
  return [
    { action: 'switch', label: 'Trocar fonte' },
    { action: 'stop-broadcast', label: 'Parar transmissão', danger: true, separatorBefore: true },
  ];
}

/** The keyboard way to open a context menu: the ContextMenu key or Shift+F10. */
export function isContextMenuKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Where to put a menu of `size` opened at `point` so it stays inside `viewport` with `margin`
 * pixels to spare: it flips to the left/top of the point when there is no room to the
 * right/below, and is pinned to the margin when it is bigger than the space on both sides.
 */
export function clampMenuPosition(point: Point, size: Size, viewport: Size, margin = 8): Point {
  const fit = (start: number, extent: number, limit: number): number => {
    if (start + extent + margin <= limit) return Math.max(margin, start);
    const flipped = start - extent;
    if (flipped >= margin) return flipped;
    return Math.max(margin, limit - extent - margin);
  };
  return {
    x: fit(point.x, size.width, viewport.width),
    y: fit(point.y, size.height, viewport.height),
  };
}

/** Index of the item reached from `current` with a navigation key, wrapping around. */
export function nextMenuIndex(current: number, count: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
