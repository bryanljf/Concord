import { describe, expect, it } from 'vitest';
import type { PresenceParticipant, PresenceSnapshot } from '@concord/shared';
import type { NowPlaying } from '../../preload/api';
import {
  addListening,
  listenersLabel,
  listenersTitle,
  musicArtDataUrl,
  musicElsewhere,
  musicProgress,
  musicVolumeOf,
  pendingListenReady,
  presenceMusic,
  pruneListening,
  removeListening,
  watchingWithMusic,
  withMusicMuteToggled,
  withMusicVolume,
  type MusicVolumes,
} from './musicListening';

const person = (id: string, music?: boolean): PresenceParticipant => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  streaming: false,
  joinedAt: 1,
  ...(music === undefined ? {} : { music }),
});

const snapshot: PresenceSnapshot = {
  rooms: {
    'sala-1': [person('eu', true), person('caio', true), person('ana', true), person('beto')],
    'sala-2': [person('duda', true), person('edu', false)],
    'sala-3': [],
  },
};

const playing: NowPlaying = {
  app: 'spotify',
  title: 'Dusk Till Dawn',
  artist: 'Bart Skils',
  album: 'Torn Clouds',
  state: 'playing',
  ad: false,
  positionMs: 60_000,
  durationMs: 240_000,
  at: 1_000_000,
  artId: 'abc',
};

describe('presenceMusic', () => {
  it('lists everyone broadcasting music, room by room, by name', () => {
    expect(presenceMusic(snapshot).map((entry) => [entry.room, entry.participant.id])).toEqual([
      ['sala-1', 'ana'],
      ['sala-1', 'caio'],
      ['sala-1', 'eu'],
      ['sala-2', 'duda'],
    ]);
  });

  it('is empty when nobody broadcasts music (older servers never send the field)', () => {
    expect(presenceMusic({ rooms: { 'sala-1': [person('ana'), person('beto', false)] } })).toEqual(
      [],
    );
  });
});

describe('musicElsewhere', () => {
  const all = presenceMusic(snapshot);

  it('keeps the other rooms while connected (the room itself comes from livekit)', () => {
    expect(musicElsewhere(all, 'sala-1', true, 'eu').map((entry) => entry.participant.id)).toEqual([
      'duda',
    ]);
  });

  it('includes the current room while not connected to it, never yourself', () => {
    expect(musicElsewhere(all, 'sala-1', false, 'eu').map((entry) => entry.participant.id)).toEqual(
      ['ana', 'caio', 'duda'],
    );
    expect(musicElsewhere(all, null, false, 'eu').map((entry) => entry.participant.id)).toEqual([
      'ana',
      'caio',
      'duda',
    ]);
  });
});

describe('watchingWithMusic', () => {
  it('adds <id>#music for each music you listen to', () => {
    expect(watchingWithMusic(['ana', 'beto#camera'], ['caio'])).toEqual([
      'ana',
      'beto#camera',
      'caio#music',
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

describe('musicProgress', () => {
  it('moves with the clock while playing', () => {
    expect(musicProgress(playing, 1_030_000)).toEqual({
      positionMs: 90_000,
      durationMs: 240_000,
      fraction: 0.375,
    });
  });

  it('freezes while paused', () => {
    const paused: NowPlaying = { ...playing, state: 'paused' };
    expect(musicProgress(paused, 1_030_000).positionMs).toBe(60_000);
    expect(musicProgress(paused, 9_999_999).positionMs).toBe(60_000);
  });

  it('stops at the end and never runs backwards', () => {
    expect(musicProgress(playing, 99_000_000).fraction).toBe(1);
    expect(musicProgress(playing, 0).positionMs).toBe(60_000);
  });

  it('shows an empty bar when the duration is unknown', () => {
    expect(musicProgress({ ...playing, durationMs: 0 }, 1_030_000).fraction).toBe(0);
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

  it('keeps each broadcaster apart and never mutates the previous map', () => {
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

describe('musicArtDataUrl', () => {
  it('turns the base64 JPEG reply into a data URL', () => {
    expect(musicArtDataUrl('/9j/4AAQSkZJRg==')).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    expect(musicArtDataUrl(' /9j/4AAQ\n')).toBe('data:image/jpeg;base64,/9j/4AAQ');
  });

  it('accepts an image data URL as it is', () => {
    expect(musicArtDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('ignores empty, malformed, foreign or oversized replies', () => {
    expect(musicArtDataUrl('')).toBeNull();
    expect(musicArtDataUrl('data:image/jpeg;base64,')).toBeNull();
    expect(musicArtDataUrl('{"error":"unknown"}')).toBeNull();
    expect(musicArtDataUrl('data:text/html;base64,PGgxPg==')).toBeNull();
    expect(musicArtDataUrl('javascript:alert(1)')).toBeNull();
    expect(musicArtDataUrl('A'.repeat(40_000))).toBeNull();
  });
});

describe('listeners', () => {
  it('counts and names who listens to your music', () => {
    expect(listenersLabel(0)).toBe('Ouvindo: 0');
    expect(listenersLabel(2)).toBe('Ouvindo: 2');
    expect(listenersTitle([])).toBe('Ninguém ouvindo ainda');
    expect(listenersTitle(['Ana'])).toBe('Ana está ouvindo');
    expect(listenersTitle(['Ana', 'Bia', 'Caio'])).toBe('Ana, Bia e Caio estão ouvindo');
  });
});
