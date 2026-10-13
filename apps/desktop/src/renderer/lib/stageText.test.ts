import { describe, expect, it } from 'vitest';
import { liveCardsTitle, stageTitles } from './stageText';

describe('stageTitles', () => {
  it('names the room by its label, without the "#" prefix', () => {
    expect(stageTitles('sala-1')).toEqual({
      joining: 'Entrando em Sala 1…',
      failed: 'Não foi possível entrar em Sala 1',
      nobodyLive: 'Ninguém está transmitindo em Sala 1',
    });
    expect(stageTitles('geral').joining).toBe('Entrando em Geral…');
  });
});

describe('liveCardsTitle', () => {
  it('counts the lives in the room', () => {
    expect(liveCardsTitle(1, 'sala-2')).toBe('1 pessoa ao vivo em Sala 2');
    expect(liveCardsTitle(3, 'sala-3')).toBe('3 pessoas ao vivo em Sala 3');
  });
});
