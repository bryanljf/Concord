import { describe, expect, it } from 'vitest';
import type { NowPlaying } from '../../preload/api';
import {
  looksLikeMusicAppWindow,
  musicDuplicationKey,
  musicDuplicationWarning,
  screenAudioIncludesMusic,
  type ScreenAudioSource,
} from './musicWarnings';

const playing: NowPlaying = {
  app: 'spotify',
  title: 'Dusk Till Dawn',
  artist: 'Bart Skils',
  album: 'Torn Clouds',
  state: 'playing',
  ad: false,
  positionMs: 3_000,
  durationMs: 285_000,
  at: 1_000_000,
  artId: 'abc123',
};

const screen = (audio: ScreenAudioSource['audio']): ScreenAudioSource => ({
  sourceId: 'screen:0:0',
  sourceName: 'Tela 1',
  audio,
});

const appWindow = (name: string, audio: ScreenAudioSource['audio']): ScreenAudioSource => ({
  sourceId: 'window:1234:0',
  sourceName: name,
  audio,
});

describe('musicDuplicationWarning', () => {
  it('names the app', () => {
    expect(musicDuplicationWarning('spotify')).toBe(
      'O Spotify também vai no áudio da transmissão (o Windows só deixa excluir o Discord). ' +
        'Quem assiste pode silenciar um dos dois.',
    );
  });
});

describe('looksLikeMusicAppWindow', () => {
  it('matches the idle Spotify window titles', () => {
    expect(looksLikeMusicAppWindow('spotify', 'Spotify Premium', null)).toBe(true);
    expect(looksLikeMusicAppWindow('spotify', 'spotify', null)).toBe(true);
    expect(looksLikeMusicAppWindow('spotify', 'Spotify Free', playing)).toBe(true);
  });

  it('matches "artist - title" while playing, whatever the dash and spacing', () => {
    expect(looksLikeMusicAppWindow('spotify', 'Bart Skils - Dusk Till Dawn', playing)).toBe(true);
    expect(looksLikeMusicAppWindow('spotify', '  bart skils  –  dusk till dawn ', playing)).toBe(
      true,
    );
  });

  it('ignores other windows', () => {
    expect(looksLikeMusicAppWindow('spotify', 'Valorant', playing)).toBe(false);
    expect(looksLikeMusicAppWindow('spotify', 'Bart Skils - Dusk Till Dawn', null)).toBe(false);
    expect(looksLikeMusicAppWindow('spotify', 'Dusk Till Dawn', playing)).toBe(false);
    expect(looksLikeMusicAppWindow('spotify', '', playing)).toBe(false);
  });

  it('does not match an empty title or artist (ads, nothing playing)', () => {
    const ad: NowPlaying = { ...playing, title: 'Advertisement', artist: '', ad: true };
    expect(looksLikeMusicAppWindow('spotify', 'Advertisement', ad)).toBe(false);
    expect(looksLikeMusicAppWindow('spotify', ' - ', { ...playing, title: '', artist: '' })).toBe(
      false,
    );
  });
});

describe('screenAudioIncludesMusic', () => {
  it('never duplicates without audio', () => {
    expect(screenAudioIncludesMusic(screen('none'), 'spotify', playing)).toBe(false);
    expect(screenAudioIncludesMusic(appWindow('Spotify', 'none'), 'spotify', playing)).toBe(false);
  });

  it('a screen with audio always carries the music (only Discord can be excluded)', () => {
    expect(screenAudioIncludesMusic(screen('process'), 'spotify', null)).toBe(true);
    expect(screenAudioIncludesMusic(screen('system'), 'spotify', null)).toBe(true);
  });

  it('the system loopback carries the music whatever the window', () => {
    expect(screenAudioIncludesMusic(appWindow('Valorant', 'system'), 'spotify', playing)).toBe(
      true,
    );
  });

  it('a window with app audio only carries the music when it is the music app', () => {
    expect(screenAudioIncludesMusic(appWindow('Valorant', 'process'), 'spotify', playing)).toBe(
      false,
    );
    expect(screenAudioIncludesMusic(appWindow('Spotify Premium', 'process'), 'spotify', null)).toBe(
      true,
    );
    expect(
      screenAudioIncludesMusic(
        appWindow('Bart Skils - Dusk Till Dawn', 'process'),
        'spotify',
        playing,
      ),
    ).toBe(true);
  });
});

describe('musicDuplicationKey', () => {
  const live = { ...screen('process'), startedAt: 42 };

  it('is null unless both are live and the screen audio carries the music', () => {
    expect(musicDuplicationKey(null, { app: 'spotify', nowPlaying: playing })).toBeNull();
    expect(musicDuplicationKey(live, null)).toBeNull();
    expect(
      musicDuplicationKey({ ...live, audio: 'none' }, { app: 'spotify', nowPlaying: playing }),
    ).toBeNull();
  });

  it('stays the same for the whole screen live', () => {
    const music = { app: 'spotify' as const, nowPlaying: playing };
    expect(musicDuplicationKey(live, music)).toBe('42:spotify');
    expect(musicDuplicationKey({ ...live, sourceId: 'screen:1:0' }, music)).toBe('42:spotify');
    expect(musicDuplicationKey({ ...live, startedAt: 43 }, music)).toBe('43:spotify');
  });
});
