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
  it('counts the people live when there are only screen shares', () => {
    expect(liveCardsTitle({ screens: 1, cameras: 0 }, 'sala-2')).toBe('1 pessoa ao vivo em Sala 2');
    expect(liveCardsTitle({ screens: 3, cameras: 0 }, 'sala-3')).toBe(
      '3 pessoas ao vivo em Sala 3',
    );
  });

  it('counts the cameras when there are only webcams', () => {
    expect(liveCardsTitle({ screens: 0, cameras: 1 }, 'sala-1')).toBe('1 câmera ligada em Sala 1');
    expect(liveCardsTitle({ screens: 0, cameras: 2 }, 'sala-1')).toBe(
      '2 câmeras ligadas em Sala 1',
    );
  });

  it('counts screen shares and cameras separately when there are both', () => {
    expect(liveCardsTitle({ screens: 2, cameras: 1 }, 'sala-1')).toBe(
      '2 transmissões ao vivo e 1 câmera em Sala 1',
    );
    expect(liveCardsTitle({ screens: 1, cameras: 3 }, 'geral')).toBe(
      '1 transmissão ao vivo e 3 câmeras em Geral',
    );
  });
});

describe('liveCardsTitle with the Jam', () => {
  it('names the Jam alone', () => {
    expect(liveCardsTitle({ screens: 0, cameras: 0, jam: true }, 'sala-1')).toBe(
      'Jam tocando em Sala 1',
    );
  });

  it('adds the Jam last when mixed', () => {
    expect(liveCardsTitle({ screens: 1, cameras: 0, jam: true }, 'sala-1')).toBe(
      '1 transmissão ao vivo e a Jam em Sala 1',
    );
    expect(liveCardsTitle({ screens: 0, cameras: 2, jam: true }, 'sala-2')).toBe(
      '2 câmeras e a Jam em Sala 2',
    );
    expect(liveCardsTitle({ screens: 2, cameras: 1, jam: true }, 'sala-1')).toBe(
      '2 transmissões ao vivo, 1 câmera e a Jam em Sala 1',
    );
  });

  it('keeps the titles without the Jam unchanged', () => {
    expect(liveCardsTitle({ screens: 2, cameras: 0, jam: false }, 'sala-1')).toBe(
      '2 pessoas ao vivo em Sala 1',
    );
  });
});
