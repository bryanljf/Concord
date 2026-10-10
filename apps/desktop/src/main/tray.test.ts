import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '' },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: vi.fn(),
  nativeImage: { createFromPath: vi.fn() },
}));

import { trayTooltip } from './tray';

describe('trayTooltip', () => {
  it('describes each tray state in pt-BR', () => {
    expect(trayTooltip({ state: 'offline', detail: null })).toBe('Telão — desconectado');
    expect(trayTooltip({ state: 'idle', detail: null })).toBe('Telão — conectado');
    expect(trayTooltip({ state: 'live', detail: 'Fulano ao vivo em #jogos' })).toBe(
      'Telão — Fulano ao vivo em #jogos',
    );
    expect(trayTooltip({ state: 'live', detail: null })).toBe('Telão — alguém ao vivo');
  });
});
