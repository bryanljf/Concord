import { describe, expect, it } from 'vitest';
import type { NowPlaying } from '../../preload/api';
import {
  decodeMusicAttribute,
  encodeMusicAttribute,
  extrapolatePosition,
  formatTrackTime,
  musicChanged,
  musicTrackName,
  parseMusicTrackName,
  steadyNowPlaying,
} from './music';

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

describe('music track name', () => {
  it('round-trips the app', () => {
    expect(musicTrackName('spotify')).toBe('concord:music:spotify');
    expect(parseMusicTrackName('concord:music:spotify')).toBe('spotify');
  });

  it('ignores other tracks and unknown apps', () => {
    expect(parseMusicTrackName('Valorant')).toBeNull();
    expect(parseMusicTrackName('concord:music:winamp')).toBeNull();
  });
});

describe('music attribute', () => {
  it('round-trips what is playing', () => {
    expect(decodeMusicAttribute(encodeMusicAttribute('spotify', playing))).toEqual({
      app: 'spotify',
      nowPlaying: playing,
    });
  });

  it('encodes "nothing playing"', () => {
    expect(decodeMusicAttribute(encodeMusicAttribute('spotify', null))).toEqual({
      app: 'spotify',
      nowPlaying: null,
    });
  });

  it('stays small', () => {
    expect(encodeMusicAttribute('spotify', playing).length).toBeLessThan(300);
  });

  it('rejects missing, broken or foreign values', () => {
    expect(decodeMusicAttribute(undefined)).toBeNull();
    expect(decodeMusicAttribute('')).toBeNull();
    expect(decodeMusicAttribute('{')).toBeNull();
    expect(decodeMusicAttribute('{"v":2,"app":"spotify"}')).toBeNull();
    expect(decodeMusicAttribute('{"v":1,"app":"winamp","t":"x"}')).toBeNull();
  });

  it('sanitises odd fields', () => {
    const decoded = decodeMusicAttribute(
      JSON.stringify({ v: 1, app: 'spotify', t: 'X', s: 'dancing', p: -5, d: 'long', art: 7 }),
    );
    expect(decoded?.nowPlaying).toMatchObject({
      title: 'X',
      artist: '',
      state: 'stopped',
      positionMs: 0,
      durationMs: 0,
      artId: null,
    });
  });
});

describe('extrapolatePosition', () => {
  it('moves on with the clock while playing, up to the duration', () => {
    expect(extrapolatePosition(playing, playing.at + 10_000)).toBe(13_000);
    expect(extrapolatePosition(playing, playing.at + 10_000_000)).toBe(285_000);
  });

  it('stays put while paused', () => {
    expect(extrapolatePosition({ ...playing, state: 'paused' }, playing.at + 10_000)).toBe(3_000);
  });
});

describe('formatTrackTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTrackTime(187_000)).toBe('3:07');
    expect(formatTrackTime(3_723_000)).toBe('1:02:03');
    expect(formatTrackTime(-5)).toBe('0:00');
  });
});

describe('musicChanged', () => {
  it('ignores the clock moving on', () => {
    expect(musicChanged(playing, { ...playing, positionMs: 8_000, at: playing.at + 5_000 })).toBe(
      false,
    );
  });

  it('notices another track, state, cover or a seek', () => {
    expect(musicChanged(playing, { ...playing, title: 'Outra' })).toBe(true);
    expect(musicChanged(playing, { ...playing, state: 'paused' })).toBe(true);
    expect(musicChanged(playing, { ...playing, artId: 'def' })).toBe(true);
    expect(musicChanged(playing, { ...playing, positionMs: 120_000, at: playing.at + 1_000 })).toBe(
      true,
    );
    expect(musicChanged(null, playing)).toBe(true);
    expect(musicChanged(null, null)).toBe(false);
  });
});

describe('steadyNowPlaying', () => {
  it('keeps the anchor for a stale reading of the same playing track', () => {
    const stale = { ...playing, positionMs: 6_000, at: playing.at + 6_000 }; // 3 s behind
    expect(steadyNowPlaying(playing, stale).positionMs).toBe(9_000);
  });

  it('takes fresher readings, seeks, other tracks and state changes as they are', () => {
    const fresher = { ...playing, positionMs: 10_000, at: playing.at + 6_000 };
    expect(steadyNowPlaying(playing, fresher)).toBe(fresher);
    const seekBack = { ...playing, positionMs: 1_000, at: playing.at + 60_000 };
    expect(steadyNowPlaying(playing, seekBack)).toBe(seekBack);
    const other = { ...playing, title: 'Outra', positionMs: 0, at: playing.at + 1_000 };
    expect(steadyNowPlaying(playing, other)).toBe(other);
    const paused = {
      ...playing,
      state: 'paused' as const,
      positionMs: 4_000,
      at: playing.at + 2_000,
    };
    expect(steadyNowPlaying(playing, paused)).toBe(paused);
    expect(steadyNowPlaying(null, playing)).toBe(playing);
  });
});
