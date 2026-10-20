/**
 * Pure helpers for the custom context menu (components/ContextMenu.tsx): the items offered on a
 * watched stream or on your own previews, the keyboard shortcuts that open it, and keeping it
 * inside the viewport.
 */
import type { StreamKind } from './streamKey';

/** The stream in destaque, a watched stream in the strip, or a tile of the grid. */
export type WatchedTileKind = 'focused' | 'mini' | 'grid';

export type WatchMenuAction =
  | 'focus'
  | 'grid'
  | 'popout'
  | 'return'
  | 'pip-open'
  | 'pip-close'
  | 'mute'
  | 'unmute'
  | 'stats'
  | 'stop';

export interface WatchMenuItem {
  action: WatchMenuAction;
  /** pt-BR label shown in the menu. */
  label: string;
  /** Destructive look (red on hover). */
  danger?: boolean;
  /** Draws a divider above the item. */
  separatorBefore?: boolean;
}

export interface WatchMenuOptions {
  tile: WatchedTileKind;
  kind: StreamKind;
  /** The screen share is muted in this window. */
  muted: boolean;
  /** The screen share carries audio. */
  hasAudio: boolean;
  /** 2+ watched streams: destaque can go back to the grid. */
  canShowGrid: boolean;
  /** The cameras' picture-in-picture window is open. */
  pipOpen: boolean;
  /** Shown by another window (the pop-out, the picture-in-picture) instead of this one. */
  elsewhere: boolean;
}

/**
 * Items of the menu opened on a watched stream. A tile of the grid or the strip can go in
 * destaque; the destaque can go back to the grid. A screen share opens in the pop-out (or comes
 * back from it), a webcam opens or closes the cameras' picture-in-picture. Mute and statistics
 * only apply to what plays in this window. "Parar de assistir" stays last, below a divider,
 * like other destructive actions.
 */
export function watchMenuItems(options: WatchMenuOptions): WatchMenuItem[] {
  const { tile, kind, muted, hasAudio, canShowGrid, pipOpen, elsewhere } = options;
  const items: WatchMenuItem[] = [];
  if (tile !== 'focused') items.push({ action: 'focus', label: 'Colocar em destaque' });
  if (tile === 'focused' && canShowGrid) {
    items.push({ action: 'grid', label: 'Voltar para a grade' });
  }
  if (kind === 'screen') {
    items.push(
      elsewhere
        ? { action: 'return', label: 'Trazer para esta janela' }
        : { action: 'popout', label: 'Abrir em pop-out' },
    );
  } else {
    items.push(
      pipOpen
        ? { action: 'pip-close', label: 'Fechar picture-in-picture' }
        : { action: 'pip-open', label: 'Abrir câmeras em picture-in-picture' },
    );
  }
  if (!elsewhere) {
    if (kind === 'screen' && hasAudio) {
      items.push(
        muted ? { action: 'unmute', label: 'Ativar som' } : { action: 'mute', label: 'Silenciar' },
      );
    }
    items.push({ action: 'stats', label: 'Estatísticas da transmissão' });
  }
  items.push({ action: 'stop', label: 'Parar de assistir', danger: true, separatorBefore: true });
  return items;
}

export type LocalPreviewMenuAction =
  'switch' | 'pick-camera' | 'stats' | 'stop-broadcast' | 'stop-camera';

export interface LocalPreviewMenuItem {
  action: LocalPreviewMenuAction;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

/** Items of the menu opened on your own screen preview or camera preview. */
export function localPreviewMenuItems(source: StreamKind): LocalPreviewMenuItem[] {
  const stats: LocalPreviewMenuItem = { action: 'stats', label: 'Estatísticas da transmissão' };
  if (source === 'camera') {
    return [
      { action: 'pick-camera', label: 'Escolher câmera…' },
      stats,
      { action: 'stop-camera', label: 'Desligar câmera', danger: true, separatorBefore: true },
    ];
  }
  return [
    { action: 'switch', label: 'Trocar fonte' },
    stats,
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
