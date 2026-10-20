import { describe, expect, it } from 'vitest';
import { roomShortLabel } from './roomShortLabel';

describe('roomShortLabel', () => {
  it('keeps a trailing number after the first letter', () => {
    expect(roomShortLabel('sala-1')).toBe('S1');
    expect(roomShortLabel('sala_12')).toBe('S12');
    expect(roomShortLabel('sala12')).toBe('S12');
    expect(roomShortLabel('sala-de-jogos-2')).toBe('S2');
  });

  it('uses the initials of the first two words', () => {
    expect(roomShortLabel('jogos_fds')).toBe('JF');
    expect(roomShortLabel('filmes-de-terror')).toBe('FD');
  });

  it('uses the first two letters of a single word', () => {
    expect(roomShortLabel('lobby')).toBe('LO');
    expect(roomShortLabel('área')).toBe('ÁR');
    expect(roomShortLabel('x')).toBe('X');
  });

  it('handles ids that are only a number or empty', () => {
    expect(roomShortLabel('42')).toBe('42');
    expect(roomShortLabel('')).toBe('?');
    expect(roomShortLabel('--')).toBe('?');
  });
});
