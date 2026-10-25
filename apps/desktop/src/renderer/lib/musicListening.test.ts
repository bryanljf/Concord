import { describe, expect, it } from 'vitest';
import {
  addListening,
  musicVolumeOf,
  pendingListenReady,
  pruneListening,
  removeListening,
  watchingWithMusic,
  withMusicMuteToggled,
  withMusicVolume,
  type MusicVolumes,
} from './musicListening';

describe('watchingWithMusic', () => {
  it('adds <id>#music for each music you listen to (@jam#music for the Jam)', () => {
    expect(watchingWithMusic(['ana', 'beto#camera'], ['@jam'])).toEqual([
      'ana',
      'beto#camera',
      '@jam#music',
    ]);
  });

  it('returns the watched keys themselves when you listen to nothing', () => {
    const watched = ['ana'];
    expect(watchingWithMusic(watched, [])).toBe(watched);
  });
});

describe('listening list', () => {
  it('adds once, in the order picked, and removes', () => {
    const one = addListening([], 'ana');
    expect(one).toEqual(['ana']);
    expect(addListening(one, 'ana')).toBe(one);
    // One music at a time: listening to another replaces the first.
    const other = addListening(one, 'beto');
    expect(other).toEqual(['beto']);
    expect(removeListening(other, 'beto')).toEqual([]);
    expect(removeListening(other, 'zeca')).toBe(other);
    expect(removeListening(['ana', 'beto'], 'ana')).toEqual(['beto']);
  });

  it('drops music that went off the air, keeping the same list when nothing changed', () => {
    const ids = ['ana', 'beto'];
    expect(pruneListening(ids, ['beto', 'caio'])).toEqual(['beto']);
    expect(pruneListening(ids, ['ana', 'beto'])).toBe(ids);
    expect(pruneListening(ids, [])).toEqual([]);
  });
});

describe('pendingListenReady', () => {
  const pending = { room: 'sala-2', participantId: 'duda' };

  it('starts once connected to the room with the music published', () => {
    expect(pendingListenReady(pending, 'sala-2', true, ['duda'])).toBe(true);
  });

  it('waits while joining, connecting or before the track shows up', () => {
    expect(pendingListenReady(pending, 'sala-1', true, ['duda'])).toBe(false);
    expect(pendingListenReady(pending, null, false, [])).toBe(false);
    expect(pendingListenReady(pending, 'sala-2', false, ['duda'])).toBe(false);
    expect(pendingListenReady(pending, 'sala-2', true, ['edu'])).toBe(false);
  });
});

describe('music volume', () => {
  const none: MusicVolumes = new Map();

  it('starts at 50 %, unmuted', () => {
    expect(musicVolumeOf(none, 'ana')).toEqual({ volume: 50, muted: false });
  });

  it('moves in steps of 1 % between 0 and 100 %', () => {
    expect(musicVolumeOf(withMusicVolume(none, 'ana', 51), 'ana').volume).toBe(51);
    expect(musicVolumeOf(withMusicVolume(none, 'ana', 49.4), 'ana').volume).toBe(49);
    expect(musicVolumeOf(withMusicVolume(none, 'ana', 150), 'ana').volume).toBe(100);
    expect(musicVolumeOf(withMusicVolume(none, 'ana', -3), 'ana').volume).toBe(0);
    for (let volume = 0; volume <= 100; volume += 1) {
      expect(musicVolumeOf(withMusicVolume(none, 'ana', volume), 'ana').volume).toBe(volume);
    }
  });

  it('keeps each music apart and never mutates the previous map', () => {
    const next = withMusicVolume(none, 'ana', 80);
    expect(none.size).toBe(0);
    expect(musicVolumeOf(next, 'beto').volume).toBe(50);
  });

  it('mutes keeping the volume; moving the slider above zero unmutes', () => {
    const muted = withMusicMuteToggled(withMusicVolume(none, 'ana', 70), 'ana');
    expect(musicVolumeOf(muted, 'ana')).toEqual({ volume: 70, muted: true });
    expect(musicVolumeOf(withMusicMuteToggled(muted, 'ana'), 'ana')).toEqual({
      volume: 70,
      muted: false,
    });
    expect(musicVolumeOf(withMusicVolume(muted, 'ana', 30), 'ana')).toEqual({
      volume: 30,
      muted: false,
    });
    expect(musicVolumeOf(withMusicVolume(muted, 'ana', 0), 'ana')).toEqual({
      volume: 0,
      muted: true,
    });
  });
});
