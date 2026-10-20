import { describe, expect, it } from 'vitest';
import type { MusicAppStatus, NowPlaying } from '../../preload/api';
import type { SessionSnapshot } from './protocol';
import {
  buildNowPlaying,
  extrapolatePosition,
  isAdvertisement,
  musicStatusChanged,
  pickSession,
  playbackState,
} from './snapshot';

const NOW = 1_800_000_000_000;

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sourceAppId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
    title: 'Dusk Till Dawn',
    artist: 'Bart Skils',
    album: 'Torn Clouds',
    playbackStatus: 4,
    positionSec: 61.5,
    durationSec: 412.25,
    lastUpdatedTime: NOW - 1_000,
    artId: '0123456789abcdef',
    ...overrides,
  };
}

function nowPlaying(overrides: Partial<NowPlaying> = {}): NowPlaying {
  return {
    app: 'spotify',
    title: 'Dusk Till Dawn',
    artist: 'Bart Skils',
    album: 'Torn Clouds',
    state: 'playing',
    ad: false,
    positionMs: 61_500,
    durationMs: 412_250,
    at: NOW - 1_000,
    artId: '0123456789abcdef',
    ...overrides,
  };
}

describe('playbackState', () => {
  it('maps the SMTC statuses', () => {
    expect(playbackState(4, null)).toBe('playing');
    expect(playbackState(5, 'playing')).toBe('paused');
    for (const status of [0, 1, 3, 99]) expect(playbackState(status, 'playing')).toBe('stopped');
  });

  it('keeps the previous state while changing tracks', () => {
    expect(playbackState(2, 'playing')).toBe('playing');
    expect(playbackState(2, 'paused')).toBe('paused');
    expect(playbackState(2, null)).toBe('stopped');
  });
});

describe('isAdvertisement', () => {
  it('flags Spotify ads', () => {
    expect(isAdvertisement('Spotify', '', '')).toBe(true);
    expect(isAdvertisement('Advertisement', 'Spotify', '')).toBe(true);
    expect(isAdvertisement('Compre já', '', '')).toBe(true);
    expect(isAdvertisement('spotify', 'x', 'y')).toBe(true);
  });

  it('leaves music alone', () => {
    expect(isAdvertisement('Dusk Till Dawn', 'Bart Skils', 'Torn Clouds')).toBe(false);
    expect(isAdvertisement('Single', 'Artist', '')).toBe(false);
    expect(isAdvertisement('Spotify Anthem', 'Band', '')).toBe(false);
  });
});

describe('buildNowPlaying', () => {
  it('maps a playing session (seconds to ms, timestamp, cover)', () => {
    expect(buildNowPlaying('spotify', session(), null, '0123456789abcdef', NOW)).toEqual(
      nowPlaying(),
    );
  });

  it('trims texts, clamps the position and falls back to now without a timestamp', () => {
    const result = buildNowPlaying(
      'spotify',
      session({ title: '  Song ', positionSec: 500, durationSec: 200, lastUpdatedTime: 0 }),
      null,
      null,
      NOW,
    );
    expect(result).toMatchObject({
      title: 'Song',
      positionMs: 200_000,
      durationMs: 200_000,
      at: NOW,
    });
  });

  it('ignores a stale reading behind the anchor while the same track plays', () => {
    // Real Spotify readings: 5.1 s at t=10.5 s, then 9.6 s at t=12.1 s, then 14.1 s at t=19.5 s.
    const start = buildNowPlaying(
      'spotify',
      session({ positionSec: 0, lastUpdatedTime: NOW + 2_000 }),
      null,
      null,
      NOW + 2_000,
    );
    const stale = buildNowPlaying(
      'spotify',
      session({ positionSec: 5.083, lastUpdatedTime: NOW + 10_500 }),
      start,
      null,
      NOW + 10_500,
    );
    // Kept on the anchor (0 s at t=2 s → 8.5 s at t=10.5 s), never back to 5.1 s.
    expect(stale?.positionMs).toBe(8_500);
    const later = buildNowPlaying(
      'spotify',
      session({ positionSec: 14.09, lastUpdatedTime: NOW + 19_540 }),
      stale,
      null,
      NOW + 19_540,
    );
    expect(later?.positionMs).toBe(17_540);
  });

  it('takes a fresher reading, a seek forward or a seek back as it is', () => {
    const playing = buildNowPlaying(
      'spotify',
      session({ positionSec: 10, lastUpdatedTime: NOW }),
      null,
      null,
      NOW,
    );
    const ahead = (positionSec: number) =>
      buildNowPlaying(
        'spotify',
        session({ positionSec, lastUpdatedTime: NOW + 1_000 }),
        playing,
        null,
        NOW + 1_000,
      )?.positionMs;
    expect(ahead(12)).toBe(12_000); // fresher than the anchor (11 s)
    expect(ahead(90)).toBe(90_000); // seek forward
    expect(ahead(2)).toBe(2_000); // seek back beyond the stale margin
  });

  it('takes the reading as it is when the state changes', () => {
    const playing = buildNowPlaying(
      'spotify',
      session({ positionSec: 30, lastUpdatedTime: NOW }),
      null,
      null,
      NOW,
    );
    const paused = buildNowPlaying(
      'spotify',
      session({ positionSec: 31, playbackStatus: 5, lastUpdatedTime: NOW + 4_000 }),
      playing,
      null,
      NOW + 4_000,
    );
    expect(paused).toMatchObject({ state: 'paused', positionMs: 31_000 });
  });

  it('never dates the position in the future', () => {
    expect(
      buildNowPlaying('spotify', session({ lastUpdatedTime: NOW + 60_000 }), null, null, NOW)?.at,
    ).toBe(NOW);
  });

  it('marks ads', () => {
    const ad = buildNowPlaying(
      'spotify',
      session({ title: 'Spotify', artist: '', album: '' }),
      null,
      null,
      NOW,
    );
    expect(ad?.ad).toBe(true);
  });

  it('returns null for an empty session that is not playing', () => {
    const empty = session({ title: '', artist: '', album: '', playbackStatus: 3 });
    expect(buildNowPlaying('spotify', empty, null, null, NOW)).toBeNull();
    // An untitled thing that plays is shown (as an ad).
    expect(buildNowPlaying('spotify', { ...empty, playbackStatus: 4 }, null, null, NOW)?.ad).toBe(
      true,
    );
  });

  it('keeps the previous state while the track is changing', () => {
    const result = buildNowPlaying(
      'spotify',
      session({ playbackStatus: 2 }),
      nowPlaying({ state: 'paused' }),
      null,
      NOW,
    );
    expect(result?.state).toBe('paused');
  });

  it('keeps the cover of the same track when it goes missing, accepts a newer one', () => {
    const previous = nowPlaying({ artId: 'aaaaaaaaaaaaaaaa' });
    expect(buildNowPlaying('spotify', session(), previous, null, NOW)?.artId).toBe(
      'aaaaaaaaaaaaaaaa',
    );
    expect(buildNowPlaying('spotify', session(), previous, 'bbbbbbbbbbbbbbbb', NOW)?.artId).toBe(
      'bbbbbbbbbbbbbbbb',
    );
    // Another track never inherits the previous cover.
    expect(
      buildNowPlaying('spotify', session({ title: 'Other' }), previous, null, NOW)?.artId,
    ).toBeNull();
  });
});

describe('pickSession', () => {
  it('prefers playing, then paused, then the newest', () => {
    const stopped = session({ playbackStatus: 3, lastUpdatedTime: NOW });
    const paused = session({ playbackStatus: 5, lastUpdatedTime: NOW - 10 });
    const playing = session({ playbackStatus: 4, lastUpdatedTime: NOW - 20 });
    expect(pickSession([stopped, paused, playing])).toBe(playing);
    expect(pickSession([stopped, paused])).toBe(paused);
    const newer = session({ playbackStatus: 3, lastUpdatedTime: NOW + 5 });
    expect(pickSession([stopped, newer])).toBe(newer);
    expect(pickSession([])).toBeNull();
  });
});

describe('extrapolatePosition', () => {
  it('moves only while playing and stops at the end', () => {
    const playing = nowPlaying({ positionMs: 10_000, at: NOW, durationMs: 15_000 });
    expect(extrapolatePosition(playing, NOW + 3_000)).toBe(13_000);
    expect(extrapolatePosition(playing, NOW + 60_000)).toBe(15_000);
    expect(extrapolatePosition(playing, NOW - 5_000)).toBe(10_000);
    expect(extrapolatePosition({ ...playing, state: 'paused' }, NOW + 3_000)).toBe(10_000);
  });
});

describe('musicStatusChanged', () => {
  const status = (overrides: Partial<NowPlaying> | null, running = true): MusicAppStatus => ({
    app: 'spotify',
    running,
    nowPlaying: overrides === null ? null : nowPlaying(overrides),
  });

  it('pushes the first status, open/close and session changes', () => {
    expect(musicStatusChanged(null, status(null, false))).toBe(true);
    expect(musicStatusChanged(status(null, false), status(null, true))).toBe(true);
    expect(musicStatusChanged(status(null), status({}))).toBe(true);
    expect(musicStatusChanged(status({}), status(null))).toBe(true);
    expect(musicStatusChanged(status(null, false), status(null, false))).toBe(false);
  });

  it('pushes track, state, cover and duration changes', () => {
    const base = status({});
    expect(musicStatusChanged(base, status({ title: 'Other' }))).toBe(true);
    expect(musicStatusChanged(base, status({ state: 'paused' }))).toBe(true);
    expect(musicStatusChanged(base, status({ artId: null }))).toBe(true);
    expect(musicStatusChanged(base, status({ durationMs: 1 }))).toBe(true);
    expect(musicStatusChanged(base, status({ ad: true }))).toBe(true);
  });

  it('ignores timeline ticks the clock explains, pushes seeks', () => {
    const base = status({ positionMs: 10_000, at: NOW });
    // Three seconds later, three seconds further: same song, nothing to push.
    expect(musicStatusChanged(base, status({ positionMs: 13_000, at: NOW + 3_000 }))).toBe(false);
    expect(musicStatusChanged(base, status({ positionMs: 14_500, at: NOW + 3_000 }))).toBe(false);
    // Seek forward / backward.
    expect(musicStatusChanged(base, status({ positionMs: 40_000, at: NOW + 3_000 }))).toBe(true);
    expect(musicStatusChanged(base, status({ positionMs: 1_000, at: NOW + 3_000 }))).toBe(true);
    // Paused: the position must not move at all.
    const paused = status({ state: 'paused', positionMs: 10_000, at: NOW });
    expect(
      musicStatusChanged(paused, status({ state: 'paused', positionMs: 10_000, at: NOW + 9_000 })),
    ).toBe(false);
    expect(
      musicStatusChanged(paused, status({ state: 'paused', positionMs: 30_000, at: NOW + 9_000 })),
    ).toBe(true);
  });
});
