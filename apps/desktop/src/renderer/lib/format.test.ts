import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  formatJoinedAgo,
  formatRetryIn,
  formatShortcut,
  hueFromString,
  initials,
  pluralize,
} from './format';

describe('formatShortcut', () => {
  it('maps CommandOrControl to Ctrl on Windows and Linux', () => {
    expect(formatShortcut('CommandOrControl+Shift+L')).toBe('Ctrl+Shift+L');
    expect(formatShortcut('CommandOrControl+Shift+L', 'linux')).toBe('Ctrl+Shift+L');
  });

  it('maps CommandOrControl to Cmd and Alt to Option on macOS', () => {
    expect(formatShortcut('CommandOrControl+Alt+K', 'darwin')).toBe('Cmd+Option+K');
  });

  it('maps Super to the Windows key and names special keys in pt-BR', () => {
    expect(formatShortcut('Super+Space')).toBe('Win+Espaço');
    expect(formatShortcut('Alt+Plus')).toBe('Alt++');
    expect(formatShortcut('Control+num5')).toBe('Ctrl+Num 5');
    expect(formatShortcut('Shift+Up')).toBe('Shift+↑');
    expect(formatShortcut('F9')).toBe('F9');
  });

  it('ignores empty input', () => {
    expect(formatShortcut('')).toBe('');
  });
});

describe('formatElapsed / formatJoinedAgo', () => {
  it('rounds down to the largest unit', () => {
    expect(formatElapsed(0)).toBe('agora');
    expect(formatElapsed(59_000)).toBe('agora');
    expect(formatElapsed(3 * 60_000 + 1)).toBe('3 min');
    expect(formatElapsed(2 * 3_600_000)).toBe('2 h');
    expect(formatElapsed(24 * 3_600_000)).toBe('1 dia');
    expect(formatElapsed(3 * 24 * 3_600_000)).toBe('3 dias');
  });

  it('phrases the join time', () => {
    const now = 10_000_000;
    expect(formatJoinedAgo(now - 5_000, now)).toBe('entrou agora');
    expect(formatJoinedAgo(now - 3 * 60_000, now)).toBe('entrou há 3 min');
    expect(formatJoinedAgo(now + 60_000, now)).toBe('entrou agora');
  });
});

describe('formatRetryIn', () => {
  it('rounds to whole seconds with a 1 s floor', () => {
    expect(formatRetryIn(4_600)).toBe('5 s');
    expect(formatRetryIn(200)).toBe('1 s');
  });
});

describe('initials', () => {
  it('takes the first letter of up to two words', () => {
    expect(initials('Ana Beatriz Costa')).toBe('AB');
    expect(initials('bryan')).toBe('B');
    expect(initials('  ')).toBe('?');
    expect(initials('éric')).toBe('É');
  });
});

describe('hueFromString', () => {
  it('is deterministic and within 0–359', () => {
    expect(hueFromString('bryan')).toBe(hueFromString('bryan'));
    expect(hueFromString('bryan')).not.toBe(hueFromString('ana'));
    for (const id of ['a', 'ana', 'beto', 'carla-123', '']) {
      const hue = hueFromString(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe('pluralize', () => {
  it('picks singular only for exactly one', () => {
    expect(pluralize(1, 'pessoa', 'pessoas')).toBe('1 pessoa');
    expect(pluralize(0, 'pessoa', 'pessoas')).toBe('0 pessoas');
    expect(pluralize(3, 'pessoa', 'pessoas')).toBe('3 pessoas');
  });
});
