import { describe, expect, it } from 'vitest';
import {
  clampMenuPosition,
  isContextMenuKey,
  localPreviewMenuItems,
  nextMenuIndex,
  watchMenuItems,
} from './contextMenu';

const keys = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

describe('watchMenuItems', () => {
  it('offers pop-out, mute and stop on the focused live', () => {
    const items = watchMenuItems('focused', false);
    expect(items.map((item) => item.label)).toEqual([
      'Abrir em pop-out',
      'Silenciar',
      'Parar de assistir',
    ]);
    expect(items.map((item) => item.action)).toEqual(['popout', 'mute', 'stop']);
  });

  it('offers "Ativar som" instead when the focused live is muted', () => {
    const items = watchMenuItems('focused', true);
    expect(items[1]).toEqual({ action: 'unmute', label: 'Ativar som' });
  });

  it('offers focus, pop-out and stop on a mini tile (no audio there)', () => {
    const items = watchMenuItems('mini', false);
    expect(items.map((item) => item.action)).toEqual(['focus', 'popout', 'stop']);
    expect(items[0]?.label).toBe('Colocar em destaque');
    expect(watchMenuItems('mini', true).map((item) => item.action)).toEqual([
      'focus',
      'popout',
      'stop',
    ]);
  });

  it('keeps "Parar de assistir" last, destructive and below a divider', () => {
    for (const kind of ['focused', 'mini'] as const) {
      const last = watchMenuItems(kind, false).at(-1);
      expect(last).toEqual({
        action: 'stop',
        label: 'Parar de assistir',
        danger: true,
        separatorBefore: true,
      });
    }
  });
});

describe('localPreviewMenuItems', () => {
  it('offers switching the source and stopping the broadcast (destructive, last)', () => {
    expect(localPreviewMenuItems()).toEqual([
      { action: 'switch', label: 'Trocar fonte' },
      { action: 'stop-broadcast', label: 'Parar transmissão', danger: true, separatorBefore: true },
    ]);
  });
});

describe('isContextMenuKey', () => {
  it('accepts the ContextMenu key and Shift+F10', () => {
    expect(isContextMenuKey({ ...keys, key: 'ContextMenu' })).toBe(true);
    expect(isContextMenuKey({ ...keys, key: 'F10', shiftKey: true })).toBe(true);
  });

  it('rejects F10 alone and modified combinations', () => {
    expect(isContextMenuKey({ ...keys, key: 'F10' })).toBe(false);
    expect(isContextMenuKey({ ...keys, key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isContextMenuKey({ ...keys, key: 'Enter' })).toBe(false);
  });
});

describe('clampMenuPosition', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 150 };

  it('opens at the pointer when it fits', () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('flips to the left and above near the bottom-right corner', () => {
    expect(clampMenuPosition({ x: 950, y: 780 }, size, viewport)).toEqual({ x: 750, y: 630 });
  });

  it('pins to the margin when it does not fit on either side', () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, size, { width: 250, height: 180 })).toEqual({
      x: 42,
      y: 22,
    });
    expect(clampMenuPosition({ x: 100, y: 100 }, size, { width: 150, height: 100 })).toEqual({
      x: 8,
      y: 8,
    });
  });

  it('never goes past the top-left margin', () => {
    expect(clampMenuPosition({ x: -20, y: 2 }, size, viewport)).toEqual({ x: 8, y: 8 });
  });
});

describe('nextMenuIndex', () => {
  it('moves and wraps with the arrow keys', () => {
    expect(nextMenuIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(nextMenuIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(-1, 3, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(-1, 3, 'ArrowUp')).toBe(2);
  });

  it('jumps with Home/End and ignores other keys', () => {
    expect(nextMenuIndex(1, 3, 'Home')).toBe(0);
    expect(nextMenuIndex(1, 3, 'End')).toBe(2);
    expect(nextMenuIndex(1, 3, 'Tab')).toBeNull();
    expect(nextMenuIndex(0, 0, 'ArrowDown')).toBeNull();
  });
});
