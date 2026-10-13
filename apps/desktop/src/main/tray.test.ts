import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '' },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: vi.fn(),
  nativeImage: { createFromPath: vi.fn() },
}));

import { INACTIVE_STREAMING_STATE } from './streaming';
import { resolveTrayStatus, trayTooltip } from './tray';

describe('resolveTrayStatus', () => {
  const idle = { state: 'idle', detail: null } as const;
  const someoneLive = { state: 'live', detail: 'Fulano ao vivo em Jogos' } as const;
  const selfLive = {
    active: true,
    room: 'jogos',
    sourceName: 'Elden Ring',
    quality: 'game',
  } as const;

  it('keeps the presence-derived status while not streaming', () => {
    expect(resolveTrayStatus(idle, INACTIVE_STREAMING_STATE)).toBe(idle);
    expect(resolveTrayStatus(someoneLive, INACTIVE_STREAMING_STATE)).toBe(someoneLive);
  });

  it('is live with our own detail while streaming, whatever presence says', () => {
    const expected = { state: 'live', detail: 'você está ao vivo em Jogos (Elden Ring)' };
    expect(resolveTrayStatus(idle, selfLive)).toEqual(expected);
    expect(resolveTrayStatus(someoneLive, selfLive)).toEqual(expected);
    expect(resolveTrayStatus({ state: 'offline', detail: null }, selfLive)).toEqual(expected);
    expect(trayTooltip(resolveTrayStatus(idle, selfLive))).toBe(
      'Concord — você está ao vivo em Jogos (Elden Ring)',
    );
  });
});

describe('trayTooltip', () => {
  it('describes each tray state in pt-BR', () => {
    expect(trayTooltip({ state: 'offline', detail: null })).toBe('Concord — desconectado');
    expect(trayTooltip({ state: 'idle', detail: null })).toBe('Concord — conectado');
    expect(trayTooltip({ state: 'live', detail: 'Fulano ao vivo em Jogos' })).toBe(
      'Concord — Fulano ao vivo em Jogos',
    );
    expect(trayTooltip({ state: 'live', detail: null })).toBe('Concord — alguém ao vivo');
  });
});
