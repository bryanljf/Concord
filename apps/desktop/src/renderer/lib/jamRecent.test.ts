import { describe, expect, it } from 'vitest';
import { JAM_CACHE_TTL_MS, type JamRecentTrack } from '@concord/shared';
import {
  jamRecentButtonShown,
  jamRecentEntries,
  jamRecentPlayedLabel,
  jamRecentToggleTitle,
  musicDrawerLayout,
} from './jamRecent';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Server clock "now" in these tests. */
const NOW = 1_800_000_000_000;

const recent = (videoId: string, usedAt: number, extra: Partial<JamRecentTrack> = {}) =>
  ({
    videoId,
    title: `Música ${videoId}`,
    artists: 'Daft Punk',
    album: null,
    durationMs: 369_000,
    artworkUrl: null,
    usedAt,
    ...extra,
  }) satisfies JamRecentTrack;

describe('musicDrawerLayout', () => {
  it('keeps the drawer at its width while closed, within the stage', () => {
    expect(musicDrawerLayout(1200, false)).toEqual({ drawer: 468, main: 468, recent: 0 });
    expect(musicDrawerLayout(400, false)).toEqual({ drawer: 376, main: 376, recent: 0 });
  });

  it('widens it by the whole column when the stage has room', () => {
    expect(musicDrawerLayout(1200, true)).toEqual({ drawer: 788, main: 468, recent: 320 });
  });

  it('narrows the column first, down to its minimum', () => {
    expect(musicDrawerLayout(780, true)).toEqual({ drawer: 756, main: 468, recent: 288 });
    expect(musicDrawerLayout(732, true)).toEqual({ drawer: 708, main: 468, recent: 240 });
  });

  it('then the main column, so the drawer always fits the stage', () => {
    expect(musicDrawerLayout(660, true)).toEqual({ drawer: 636, main: 396, recent: 240 });
    expect(musicDrawerLayout(200, true)).toEqual({ drawer: 176, main: 0, recent: 176 });
  });
});

describe('jamRecentButtonShown', () => {
  it('needs the drawer open, a Jam in your room and at least one song', () => {
    expect(jamRecentButtonShown(true, true, 1)).toBe(true);
    expect(jamRecentButtonShown(true, true, 0)).toBe(false);
    expect(jamRecentButtonShown(false, true, 3)).toBe(false);
    expect(jamRecentButtonShown(true, false, 3)).toBe(false);
  });
});

describe('jamRecentToggleTitle', () => {
  it('names the server cache window', () => {
    expect(jamRecentToggleTitle()).toBe(
      `Músicas tocadas nas últimas ${JAM_CACHE_TTL_MS / HOUR} horas`,
    );
    expect(jamRecentToggleTitle(3 * HOUR)).toBe('Músicas tocadas nas últimas 3 horas');
    expect(jamRecentToggleTitle(HOUR)).toBe('Músicas tocadas na última hora');
    expect(jamRecentToggleTitle(10 * MINUTE)).toBe('Músicas tocadas na última hora');
  });
});

describe('jamRecentPlayedLabel', () => {
  it('says how long ago, rounded down like the other "há" labels', () => {
    expect(jamRecentPlayedLabel(NOW - 30_000, NOW)).toBe('tocada agora');
    expect(jamRecentPlayedLabel(NOW - 5 * MINUTE, NOW)).toBe('tocada há 5 min');
    expect(jamRecentPlayedLabel(NOW - 59 * MINUTE - 59_000, NOW)).toBe('tocada há 59 min');
    expect(jamRecentPlayedLabel(NOW - 2 * HOUR - 40 * MINUTE, NOW)).toBe('tocada há 2 h');
  });

  it('reads a time slightly in the future (clock drift) as now', () => {
    expect(jamRecentPlayedLabel(NOW + 20_000, NOW)).toBe('tocada agora');
  });

  it('has no label without a usable time', () => {
    expect(jamRecentPlayedLabel(0, NOW)).toBeNull();
    expect(jamRecentPlayedLabel(Number.NaN, NOW)).toBeNull();
    expect(jamRecentPlayedLabel(NOW, Number.NaN)).toBeNull();
  });
});

describe('jamRecentEntries', () => {
  it('is empty without songs', () => {
    expect(jamRecentEntries([], NOW, 0)).toEqual([]);
  });

  it('keeps the most recently played first, ties in the server order', () => {
    const tracks = [
      recent('cccccccccc3', NOW - 2 * HOUR),
      recent('aaaaaaaaaa1', NOW - 5 * MINUTE),
      recent('ddddddddddd', NOW - 2 * HOUR),
      recent('bbbbbbbbbb2', NOW - 40 * MINUTE),
    ];
    const ids = jamRecentEntries(tracks, NOW, 0).map((entry) => entry.track.videoId);
    expect(ids).toEqual(['aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3', 'ddddddddddd']);
  });

  it('does not change the list it was given', () => {
    const tracks = [recent('old00000000', NOW - HOUR), recent('new00000000', NOW - MINUTE)];
    jamRecentEntries(tracks, NOW, 0);
    expect(tracks.map((track) => track.videoId)).toEqual(['old00000000', 'new00000000']);
  });

  it('shows each song once, at its most recent use', () => {
    const tracks = [
      recent('aaaaaaaaaa1', NOW - HOUR),
      recent('aaaaaaaaaa1', NOW - 3 * MINUTE),
      recent('bbbbbbbbbb2', NOW - 10 * MINUTE),
    ];
    const entries = jamRecentEntries(tracks, NOW, 0);
    expect(entries.map((entry) => entry.track.videoId)).toEqual(['aaaaaaaaaa1', 'bbbbbbbbbb2']);
    expect(entries[0]?.playedLabel).toBe('tocada há 3 min');
  });

  it('reads the server clock through the offset', () => {
    // This PC is 2 min behind the server: "now" here is NOW - 2 min, the server's is NOW.
    const tracks = [recent('aaaaaaaaaa1', NOW - 5 * MINUTE)];
    const [entry] = jamRecentEntries(tracks, NOW - 2 * MINUTE, 2 * MINUTE);
    expect(entry?.playedLabel).toBe('tocada há 5 min');
    const [late] = jamRecentEntries(tracks, NOW + 3 * MINUTE, -3 * MINUTE);
    expect(late?.playedLabel).toBe('tocada há 5 min');
  });

  it('names each row like a search result, plus when it played', () => {
    const [withAlbum, bare] = jamRecentEntries(
      [
        recent('aaaaaaaaaa1', NOW - 5 * MINUTE, {
          title: 'Get Lucky',
          artists: 'Daft Punk, Pharrell Williams',
          album: 'Random Access Memories',
        }),
        recent('bbbbbbbbbb2', 0, { title: '', artists: '', durationMs: 0 }),
      ],
      NOW,
      0,
    );
    expect(withAlbum?.label).toBe(
      'Adicionar Get Lucky — Daft Punk, Pharrell Williams (Random Access Memories · 6:09), tocada há 5 min',
    );
    expect(withAlbum?.meta).toBe('6:09 · tocada há 5 min');
    expect(bare?.playedLabel).toBeNull();
    expect(bare?.meta).toBe('–:––');
    expect(bare?.label).toBe('Adicionar Sem título (–:––)');
  });
});
