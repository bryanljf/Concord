import { describe, expect, it } from 'vitest';
import {
  clampMenuPosition,
  isContextMenuKey,
  localPreviewMenuItems,
  nextMenuIndex,
  watchMenuItems,
  type WatchMenuOptions,
} from './contextMenu';

const keys = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

const screen: WatchMenuOptions = {
  tile: 'focused',
  kind: 'screen',
  muted: false,
  hasAudio: true,
  canShowGrid: false,
  pipOpen: false,
  elsewhere: false,
};

const actions = (options: Partial<WatchMenuOptions>) =>
  watchMenuItems({ ...screen, ...options }).map((item) => item.action);

describe('watchMenuItems', () => {
  it('offers pop-out, mute, statistics and stop on a screen share in destaque', () => {
    const items = watchMenuItems(screen);
    expect(items.map((item) => item.label)).toEqual([
      'Abrir em pop-out',
      'Silenciar',
      'Estatísticas da transmissão',
      'Parar de assistir',
    ]);
    expect(items.map((item) => item.action)).toEqual(['popout', 'mute', 'stats', 'stop']);
  });

  it('offers "Voltar para a grade" in destaque when 2+ streams are watched', () => {
    const items = watchMenuItems({ ...screen, canShowGrid: true });
    expect(items[0]).toEqual({ action: 'grid', label: 'Voltar para a grade' });
    expect(actions({ tile: 'grid', canShowGrid: true })).not.toContain('grid');
  });

  it('offers "Colocar em destaque" on grid and mini tiles', () => {
    for (const tile of ['grid', 'mini'] as const) {
      const items = watchMenuItems({ ...screen, tile });
      expect(items[0]).toEqual({ action: 'focus', label: 'Colocar em destaque' });
    }
    expect(actions({ tile: 'focused' })).not.toContain('focus');
  });

  it('offers "Ativar som" when muted, and no mute at all without audio', () => {
    expect(watchMenuItems({ ...screen, muted: true })[1]).toEqual({
      action: 'unmute',
      label: 'Ativar som',
    });
    expect(actions({ hasAudio: false })).toEqual(['popout', 'stats', 'stop']);
  });

  it('opens or closes the picture-in-picture on a camera (no pop-out, no audio)', () => {
    const closed = watchMenuItems({ ...screen, tile: 'mini', kind: 'camera', hasAudio: false });
    expect(closed.map((item) => item.label)).toEqual([
      'Colocar em destaque',
      'Abrir câmeras em picture-in-picture',
      'Estatísticas da transmissão',
      'Parar de assistir',
    ]);
    expect(actions({ kind: 'camera', pipOpen: true })).toEqual(['pip-close', 'stats', 'stop']);
    expect(watchMenuItems({ ...screen, kind: 'camera', pipOpen: true })[0]?.label).toBe(
      'Fechar picture-in-picture',
    );
  });

  it('brings back a stream shown by another window, without mute or statistics', () => {
    const items = watchMenuItems({ ...screen, tile: 'grid', elsewhere: true });
    expect(items.map((item) => item.label)).toEqual([
      'Colocar em destaque',
      'Trazer para esta janela',
      'Parar de assistir',
    ]);
    expect(actions({ kind: 'camera', pipOpen: true, elsewhere: true })).toEqual([
      'pip-close',
      'stop',
    ]);
  });

  it('on the web: no pop-out nor PiP window, the browser picture-in-picture instead', () => {
    const web = { popout: false, pip: false, nativeVideoPip: true };
    expect(watchMenuItems({ ...screen, capabilities: web }).map((item) => item.label)).toEqual([
      'Picture-in-picture',
      'Silenciar',
      'Estatísticas da transmissão',
      'Parar de assistir',
    ]);
    expect(actions({ kind: 'camera', hasAudio: false, capabilities: web })).toEqual([
      'native-pip',
      'stats',
      'stop',
    ]);
    expect(actions({ tile: 'grid', capabilities: web })).toEqual([
      'focus',
      'native-pip',
      'mute',
      'stats',
      'stop',
    ]);
  });

  it('offers nothing window-related when the client has none of it', () => {
    const none = { popout: false, pip: false, nativeVideoPip: false };
    expect(actions({ capabilities: none })).toEqual(['mute', 'stats', 'stop']);
    expect(actions({ kind: 'camera', hasAudio: false, capabilities: none })).toEqual([
      'stats',
      'stop',
    ]);
  });

  it('keeps "Parar de assistir" last, destructive and below a divider', () => {
    for (const tile of ['focused', 'mini', 'grid'] as const) {
      for (const kind of ['screen', 'camera'] as const) {
        const last = watchMenuItems({ ...screen, tile, kind }).at(-1);
        expect(last).toEqual({
          action: 'stop',
          label: 'Parar de assistir',
          danger: true,
          separatorBefore: true,
        });
      }
    }
  });
});

describe('localPreviewMenuItems', () => {
  it('offers switching the source, statistics and stopping the broadcast (last)', () => {
    expect(localPreviewMenuItems('screen')).toEqual([
      { action: 'switch', label: 'Trocar fonte' },
      { action: 'stats', label: 'Estatísticas da transmissão' },
      { action: 'stop-broadcast', label: 'Parar transmissão', danger: true, separatorBefore: true },
    ]);
  });

  it('offers picking a camera, statistics and turning the camera off (last)', () => {
    expect(localPreviewMenuItems('camera')).toEqual([
      { action: 'pick-camera', label: 'Escolher câmera…' },
      { action: 'stats', label: 'Estatísticas da transmissão' },
      { action: 'stop-camera', label: 'Desligar câmera', danger: true, separatorBefore: true },
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
