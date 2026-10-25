import { describe, expect, it, vi } from 'vitest';
import { JAM_SEARCH_LIMIT } from '@concord/shared';
import {
  createYouTubeMusic,
  panelVideoToTrack,
  pickArtwork,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
  searchKey,
  songToTrack,
  TrackCache,
  YouTubeMusicError,
  type MusicSource,
  type PanelVideoLike,
  type SongLike,
} from '../src/jam/youtube';
import { FakeClock, track } from './jam-helpers';

const ART = 'https://yt3.googleusercontent.com/N55arCGj69gtw6thXK8JUP';

/** A search result as youtubei.js 18 returns it (measured shape). */
function song(id: string, overrides: Partial<SongLike> = {}): SongLike {
  return {
    id,
    title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
    artists: [{ name: 'Daft Punk' }, { name: 'Pharrell Williams' }, { name: 'Nile Rodgers' }],
    album: { name: 'Random Access Memories' },
    duration: { seconds: 370 },
    thumbnails: [
      { url: `${ART}=w120-h120-l90-rj`, width: 120, height: 120 },
      { url: `${ART}=w60-h60-l90-rj`, width: 60, height: 60 },
    ],
    ...overrides,
  };
}

function panelVideo(videoId: string, overrides: Partial<PanelVideoLike> = {}): PanelVideoLike {
  return {
    video_id: videoId,
    title: { toString: () => 'Get Lucky (Official Audio)' },
    artists: [{ name: 'Daft Punk' }],
    author: 'Daft Punk',
    duration: { seconds: 249 },
    thumbnail: [
      { url: `https://i.ytimg.com/vi/${videoId}/hq720.jpg`, width: 853, height: 479 },
      { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 400, height: 225 },
    ],
    ...overrides,
  };
}

function fakeSource(songs: SongLike[] = [], panels: Record<string, PanelVideoLike[]> = {}) {
  return {
    searchSongs: vi.fn<MusicSource['searchSongs']>(async () => songs),
    upNext: vi.fn<MusicSource['upNext']>(async (videoId) => panels[videoId] ?? []),
  };
}

describe('pickArtwork', () => {
  it('asks googleusercontent for the cover at 544 px', () => {
    expect(pickArtwork(song('x').thumbnails)).toBe(`${ART}=w544-h544-l90-rj`);
  });

  it('takes the largest thumbnail up to 544 px, else the smallest above it', () => {
    expect(pickArtwork(panelVideo('x').thumbnail)).toBe('https://i.ytimg.com/vi/x/hqdefault.jpg');
    expect(
      pickArtwork([
        { url: 'https://i.ytimg.com/vi/x/maxres.jpg', width: 1280, height: 720 },
        { url: 'https://i.ytimg.com/vi/x/hq720.jpg', width: 853, height: 479 },
      ]),
    ).toBe('https://i.ytimg.com/vi/x/hq720.jpg');
  });

  it('only trusts https images from googleusercontent and ytimg', () => {
    expect(
      pickArtwork([
        { url: 'http://i.ytimg.com/vi/x/hqdefault.jpg', width: 400, height: 225 },
        { url: 'https://evil.example/ytimg.com.jpg', width: 300, height: 300 },
        { url: 'not a url', width: 100, height: 100 },
      ]),
    ).toBeNull();
    expect(pickArtwork([])).toBeNull();
  });
});

describe('songToTrack', () => {
  it('maps a search result', () => {
    expect(songToTrack(song('4D7u5KF7SP8'))).toEqual({
      videoId: '4D7u5KF7SP8',
      title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
      artists: 'Daft Punk, Pharrell Williams, Nile Rodgers',
      album: 'Random Access Memories',
      durationMs: 370_000,
      artworkUrl: `${ART}=w544-h544-l90-rj`,
    });
  });

  it('accepts a song without album, artists or art', () => {
    expect(
      songToTrack(song('4D7u5KF7SP8', { album: undefined, artists: [], thumbnails: [] })),
    ).toMatchObject({ album: null, artists: '', artworkUrl: null });
  });

  it('reads an artist without a channel from the second column', () => {
    // Measured on 2026-10-24: youtubei.js lists no artists when the name links nowhere.
    const unlinked = song('cFZoD71-O2w', {
      title: 'Digital Love',
      artists: [],
      album: { name: 'Ciber Love' },
      flex_columns: [
        { title: { runs: [{ text: 'Digital Love' }] } },
        {
          title: {
            runs: [{ text: 'Fruzzy' }, { text: ' • ' }, { text: 'Ciber Love' }, { text: ' • ' }],
          },
        },
      ],
    });
    expect(songToTrack(unlinked)).toMatchObject({ artists: 'Fruzzy', album: 'Ciber Love' });
    const duo = song('cFZoD71-O2w', {
      artists: undefined,
      flex_columns: [
        {},
        { title: { runs: [{ text: 'Ana' }, { text: ' & ' }, { text: 'Bia' }, { text: ' • ' }] } },
      ],
    });
    expect(songToTrack(duo)?.artists).toBe('Ana & Bia');
  });

  it('prefers the linked artists and never takes a lone album or duration for them', () => {
    const columns: SongLike['flex_columns'] = [
      {},
      { title: { runs: [{ text: 'Daft Punk' }, { text: ' • ' }, { text: 'Discovery' }] } },
    ];
    expect(
      songToTrack(song('4D7u5KF7SP8', { artists: [{ name: 'Daft Punk' }], flex_columns: columns }))
        ?.artists,
    ).toBe('Daft Punk');
    const noSeparator = song('4D7u5KF7SP8', {
      artists: [],
      flex_columns: [{}, { title: { runs: [{ text: '3:31' }] } }],
    });
    expect(songToTrack(noSeparator)?.artists).toBe('');
    const albumFirst = song('4D7u5KF7SP8', {
      artists: [],
      album: { name: 'Discovery' },
      flex_columns: [{}, { title: { runs: [{ text: 'Discovery' }, { text: ' • ' }] } }],
    });
    expect(songToTrack(albumFirst)?.artists).toBe('');
  });

  it.each<[string, Partial<SongLike>]>([
    ['no id', { id: undefined }],
    ['a malformed id', { id: 'nope' }],
    ['no title', { title: '  ' }],
    ['no duration', { duration: undefined }],
    ['a zero duration', { duration: { seconds: 0 } }],
  ])('skips an entry with %s', (_label, overrides) => {
    expect(songToTrack(song('4D7u5KF7SP8', overrides))).toBeNull();
  });
});

describe('panelVideoToTrack', () => {
  it('maps an up-next video, falling back to its author for the artists', () => {
    expect(panelVideoToTrack(panelVideo('5NV6Rdv1a3I', { artists: undefined }))).toEqual({
      videoId: '5NV6Rdv1a3I',
      title: 'Get Lucky (Official Audio)',
      artists: 'Daft Punk',
      album: null,
      durationMs: 249_000,
      artworkUrl: 'https://i.ytimg.com/vi/5NV6Rdv1a3I/hqdefault.jpg',
    });
  });

  it('rejects a live stream (no duration)', () => {
    expect(panelVideoToTrack(panelVideo('5NV6Rdv1a3I', { duration: undefined }))).toBeNull();
  });
});

describe('TrackCache', () => {
  it('forgets the least recently used entry past its size', () => {
    const cache = new TrackCache(2);
    cache.set(track('aaaaaaaaaaa'));
    cache.set(track('bbbbbbbbbbb'));
    cache.get('aaaaaaaaaaa');
    cache.set(track('ccccccccccc'));
    expect(cache.get('bbbbbbbbbbb')).toBeUndefined();
    expect(cache.get('aaaaaaaaaaa')).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it('expires entries', () => {
    const clock = new FakeClock();
    const cache = new TrackCache(10, 1000, clock.now);
    cache.set(track('aaaaaaaaaaa'));
    clock.advance(999);
    expect(cache.get('aaaaaaaaaaa')).toBeDefined();
    clock.advance(1);
    expect(cache.get('aaaaaaaaaaa')).toBeUndefined();
  });
});

describe('createYouTubeMusic', () => {
  it('returns at most JAM_SEARCH_LIMIT valid, distinct songs', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `video${String(i).padStart(6, '0')}`);
    const source = fakeSource([song('bad'), ...ids.map((id) => song(id)), song(ids[0] ?? '')]);
    const results = await createYouTubeMusic({ source }).search('get lucky');
    expect(source.searchSongs).toHaveBeenCalledWith('get lucky');
    expect(results).toHaveLength(JAM_SEARCH_LIMIT);
    expect(results.map((result) => result.videoId)).toEqual(ids.slice(0, JAM_SEARCH_LIMIT));
  });

  it('resolves a search result from the cache, without asking YouTube again', async () => {
    const source = fakeSource([song('4D7u5KF7SP8')]);
    const youtube = createYouTubeMusic({ source });
    const [result] = await youtube.search('get lucky');
    expect(await youtube.track('4D7u5KF7SP8')).toEqual(result);
    expect(source.upNext).not.toHaveBeenCalled();
  });

  it('resolves a pasted link through "up next" and validates the video it returns', async () => {
    const source = fakeSource([], {
      '5NV6Rdv1a3I': [panelVideo('5NV6Rdv1a3I'), panelVideo('otherVideo1')],
      // YouTube answered with another video first: not the one asked for.
      xxxxxxxxxxx: [panelVideo('otherVideo1')],
    });
    const youtube = createYouTubeMusic({ source });
    expect(await youtube.track('5NV6Rdv1a3I')).toMatchObject({ videoId: '5NV6Rdv1a3I' });
    expect(await youtube.track('5NV6Rdv1a3I')).toMatchObject({ videoId: '5NV6Rdv1a3I' });
    expect(source.upNext).toHaveBeenCalledTimes(1);
    expect(await youtube.track('xxxxxxxxxxx')).toBeNull();
    expect(await youtube.track('unknownvid0')).toBeNull();
  });

  it('turns upstream failures and timeouts into YouTubeMusicError', async () => {
    const source = fakeSource();
    source.searchSongs.mockRejectedValueOnce(new Error('Sign in to confirm'));
    const youtube = createYouTubeMusic({ source, timeoutMs: 20 });
    await expect(youtube.search('x')).rejects.toBeInstanceOf(YouTubeMusicError);
    source.upNext.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(youtube.track('5NV6Rdv1a3I')).rejects.toThrow(/timed out/);
  });
});

describe('search cache', () => {
  it('answers a search typed again from memory, whatever its case or spacing', async () => {
    const source = fakeSource([song('4D7u5KF7SP8')]);
    const youtube = createYouTubeMusic({ source });
    const first = await youtube.search('Daft Punk');
    expect(await youtube.search('  daft   PUNK ')).toBe(first);
    expect(source.searchSongs).toHaveBeenCalledTimes(1);
    expect(searchKey('  Daft \t PUNK ')).toBe('daft punk');
  });

  it('asks again once the entry expired', async () => {
    const clock = new FakeClock();
    const source = fakeSource([song('4D7u5KF7SP8')]);
    const youtube = createYouTubeMusic({ source, now: clock.now });
    await youtube.search('get lucky');
    clock.advance(SEARCH_CACHE_TTL_MS - 1);
    await youtube.search('get lucky');
    expect(source.searchSongs).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await youtube.search('get lucky');
    expect(source.searchSongs).toHaveBeenCalledTimes(2);
  });

  it('shares one request between identical searches in flight', async () => {
    const source = fakeSource([song('4D7u5KF7SP8')]);
    let release = (): void => undefined;
    source.searchSongs.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([song('4D7u5KF7SP8')]))),
    );
    const youtube = createYouTubeMusic({ source });
    const a = youtube.search('get lucky');
    const b = youtube.search('Get Lucky');
    release();
    expect(await a).toEqual(await b);
    expect(source.searchSongs).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure', async () => {
    const source = fakeSource([song('4D7u5KF7SP8')]);
    source.searchSongs.mockRejectedValueOnce(new Error('network down'));
    const youtube = createYouTubeMusic({ source });
    await expect(youtube.search('get lucky')).rejects.toBeInstanceOf(YouTubeMusicError);
    await expect(youtube.search('get lucky')).resolves.toHaveLength(1);
    expect(source.searchSongs).toHaveBeenCalledTimes(2);
  });

  it('forgets the oldest searches past its size', async () => {
    const source = fakeSource([song('4D7u5KF7SP8')]);
    const youtube = createYouTubeMusic({ source });
    for (let i = 0; i <= SEARCH_CACHE_MAX_ENTRIES; i += 1) await youtube.search(`query ${i}`);
    await youtube.search(`query ${SEARCH_CACHE_MAX_ENTRIES}`);
    expect(source.searchSongs).toHaveBeenCalledTimes(SEARCH_CACHE_MAX_ENTRIES + 1);
    await youtube.search('query 0');
    expect(source.searchSongs).toHaveBeenCalledTimes(SEARCH_CACHE_MAX_ENTRIES + 2);
  });
});

describe('warmUp', () => {
  it('opens the source ahead of the first search and never rejects', async () => {
    const source = { ...fakeSource(), warmUp: vi.fn(async () => undefined) };
    await createYouTubeMusic({ source }).warmUp?.();
    expect(source.warmUp).toHaveBeenCalledTimes(1);
    source.warmUp.mockRejectedValueOnce(new Error('offline'));
    await expect(createYouTubeMusic({ source }).warmUp?.()).resolves.toBeUndefined();
  });

  it('is a no-op for a source without warm-up', async () => {
    await expect(createYouTubeMusic({ source: fakeSource() }).warmUp?.()).resolves.toBeUndefined();
  });
});
