import { describe, expect, it } from 'vitest';
import { popoutMenuItems } from './popoutMenu';

describe('popoutMenuItems', () => {
  it('offers mute, stats, back to the main window and close on a live with audio', () => {
    const items = popoutMenuItems({ muted: false, hasAudio: true });
    expect(items.map((item) => item.label)).toEqual([
      'Silenciar',
      'Estatísticas da transmissão',
      'Voltar para a janela principal',
      'Fechar',
    ]);
    expect(items.map((item) => item.action)).toEqual(['mute', 'stats', 'return', 'close']);
  });

  it('offers "Ativar som" instead when the live is muted', () => {
    const items = popoutMenuItems({ muted: true, hasAudio: true });
    expect(items[0]).toEqual({ action: 'unmute', label: 'Ativar som' });
  });

  it('leaves mute out when the live has no audio', () => {
    for (const muted of [false, true]) {
      expect(popoutMenuItems({ muted, hasAudio: false }).map((item) => item.action)).toEqual([
        'stats',
        'return',
        'close',
      ]);
    }
  });

  it('keeps "Fechar" last, destructive and below a divider', () => {
    for (const hasAudio of [false, true]) {
      const items = popoutMenuItems({ muted: false, hasAudio });
      expect(items.at(-1)).toEqual({
        action: 'close',
        label: 'Fechar',
        danger: true,
        separatorBefore: true,
      });
      expect(items.slice(0, -1).some((item) => item.danger || item.separatorBefore)).toBe(false);
    }
  });
});
