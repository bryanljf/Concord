import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JAM_BOT_IDENTITY,
  type JamItem,
  type JamNowPlaying,
  type JamState,
  type JamTrack,
} from '@concord/shared';
import type { JamUploadStatus } from '../../preload/api';
import {
  JAM_CLOCK_MAX_SAMPLES,
  JAM_CLOCK_WINDOW_MS,
  JAM_PREFETCH_DELAY_MS,
  addJamClockSample,
  createJamPrefetcher,
  jamAddedMessage,
  jamAddedStatus,
  jamArtworkSrc,
  jamClockOffset,
  jamDurationLabel,
  jamEmptyQueueText,
  jamIndicatorLabel,
  jamIndicatorSummary,
  jamItemStatusLabel,
  jamListenable,
  jamPerson,
  jamPlaying,
  jamPreviousItem,
  jamPreviousTitle,
  jamProgress,
  jamQueryHint,
  jamQueryIntent,
  jamQueueEntries,
  jamQueuePreview,
  jamQueueSummary,
  jamRoomIdle,
  jamTrackDetail,
  jamTrackLine,
  jamUploadErrorMessage,
  jamsElsewhere,
  pausedByLabel,
  requestedByLabel,
  withAddedStatuses,
  type JamClockSample,
  type JamPerson,
  type JamSelf,
} from './jam';
import type { PresenceProfile } from './presence';

const track: JamTrack = {
  videoId: '4D7u5KF7SP8',
  title: 'Get Lucky',
  artists: 'Daft Punk, Pharrell Williams',
  album: 'Random Access Memories',
  durationMs: 369_000,
  artworkUrl: 'https://lh3.googleusercontent.com/abc=w120-h120',
};

const item = (id: string, requestedBy = 'ana', status: JamItem['status'] = 'ready'): JamItem => ({
  id,
  track: { ...track, title: `Música ${id}` },
  requestedBy,
  addedAt: 1,
  status,
});

const nowPlaying = (overrides: Partial<JamNowPlaying> = {}): JamNowPlaying => ({
  item: { ...item('a'), track },
  positionMs: 10_000,
  at: 100_000,
  paused: false,
  pausedBy: null,
  ...overrides,
});

const state = (room: string, current: JamNowPlaying | null, queue: JamItem[] = []): JamState => ({
  room,
  current,
  queue,
});

const self: JamSelf = { id: 'eu', name: 'Eu Mesmo', avatarUrl: null };
const profiles: ReadonlyMap<string, PresenceProfile> = new Map([
  ['ana', { name: 'Ana', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' }],
]);

const upload = (itemId: string, uploadState: JamUploadStatus['state']): JamUploadStatus => ({
  itemId,
  room: 'sala-1',
  title: 'Get Lucky',
  state: uploadState,
  message: uploadState === 'error' ? 'O YouTube recusou o download.' : null,
});

describe('jam clock', () => {
  it('reads the offset from one message', () => {
    const samples = addJamClockSample([], 1_005_000, 1_000_000);
    expect(jamClockOffset(samples)).toBe(5_000);
  });

  it('is 0 without readings, and ignores the placeholder and broken times', () => {
    expect(jamClockOffset([])).toBe(0);
    const none: readonly JamClockSample[] = [];
    expect(addJamClockSample(none, 0, 1_000_000)).toBe(none);
    expect(addJamClockSample(none, Number.NaN, 1_000_000)).toBe(none);
    expect(addJamClockSample(none, 1_000, Number.POSITIVE_INFINITY)).toBe(none);
  });

  it('keeps the largest recent reading: delays and a stale snapshot only lower it', () => {
    let samples = addJamClockSample([], 1_000_000, 1_000_000); // offset 0 (fresh event)
    samples = addJamClockSample(samples, 940_000, 1_001_000); // a snapshot kept for a minute
    samples = addJamClockSample(samples, 1_001_800, 1_002_000); // 200 ms on the way
    expect(jamClockOffset(samples)).toBe(0);
  });

  it('forgets old readings and readings from before the clock went back', () => {
    let samples = addJamClockSample([], 1_000_000 + 5_000, 1_000_000);
    samples = addJamClockSample(
      samples,
      1_000_000 + JAM_CLOCK_WINDOW_MS + 1,
      1_000_000 + JAM_CLOCK_WINDOW_MS + 1,
    );
    expect(jamClockOffset(samples)).toBe(0);
    // The local clock jumped back an hour: the earlier reading is from another clock.
    samples = addJamClockSample([], 9_000_000, 9_000_000);
    samples = addJamClockSample(samples, 9_000_000 - 3_600_000 + 9_000, 9_000_000 - 3_600_000);
    expect(samples).toHaveLength(1);
    expect(jamClockOffset(samples)).toBe(9_000);
  });

  it('keeps at most a few readings', () => {
    let samples: readonly JamClockSample[] = [];
    for (let index = 0; index < JAM_CLOCK_MAX_SAMPLES + 5; index += 1) {
      samples = addJamClockSample(samples, 1_000_000 + index, 1_000_000 + index * 10);
    }
    expect(samples).toHaveLength(JAM_CLOCK_MAX_SAMPLES);
  });
});

describe('jamProgress', () => {
  it('moves on the server clock while playing', () => {
    // The PC is 5 s behind the server: Date.now() 96_000 + offset 5_000 = server 101_000.
    const progress = jamProgress(nowPlaying(), 96_000 + 5_000);
    expect(progress.positionMs).toBe(11_000);
    expect(progress.durationMs).toBe(369_000);
    expect(progress.fraction).toBeCloseTo(11_000 / 369_000);
  });

  it('is frozen while paused and clamped to the song', () => {
    expect(jamProgress(nowPlaying({ paused: true }), 500_000).positionMs).toBe(10_000);
    expect(jamProgress(nowPlaying(), 10_000_000)).toMatchObject({
      positionMs: 369_000,
      fraction: 1,
    });
  });

  it('shows an empty bar without a known duration', () => {
    const live = nowPlaying({ item: { ...item('x'), track: { ...track, durationMs: 0 } } });
    expect(jamProgress(live, 101_000)).toEqual({ positionMs: 11_000, durationMs: 0, fraction: 0 });
  });
});

describe('jamArtworkSrc', () => {
  it('accepts the YouTube Music covers', () => {
    expect(jamArtworkSrc('https://lh3.googleusercontent.com/abc=w120-h120')).toBe(
      'https://lh3.googleusercontent.com/abc=w120-h120',
    );
    expect(jamArtworkSrc('https://i.ytimg.com/vi/4D7u5KF7SP8/hqdefault.jpg')).toBe(
      'https://i.ytimg.com/vi/4D7u5KF7SP8/hqdefault.jpg',
    );
  });

  it('refuses anything the CSP would block, or worse', () => {
    expect(jamArtworkSrc(null)).toBeNull();
    expect(jamArtworkSrc('')).toBeNull();
    expect(jamArtworkSrc('http://i.ytimg.com/a.jpg')).toBeNull();
    expect(jamArtworkSrc('https://googleusercontent.com.evil.com/a.jpg')).toBeNull();
    expect(jamArtworkSrc('https://evilgoogleusercontent.com/a.jpg')).toBeNull();
    expect(jamArtworkSrc('https://i.ytimg.com:8443/a.jpg')).toBeNull();
    expect(jamArtworkSrc('https://user:pw@i.ytimg.com/a.jpg')).toBeNull();
    expect(jamArtworkSrc('javascript:alert(1)')).toBeNull();
    expect(jamArtworkSrc('not a url')).toBeNull();
  });
});

describe('jamQueryIntent', () => {
  it('adds YouTube and YouTube Music links directly', () => {
    expect(jamQueryIntent('https://music.youtube.com/watch?v=4D7u5KF7SP8&si=x')).toEqual({
      kind: 'link',
      videoId: '4D7u5KF7SP8',
    });
    expect(jamQueryIntent('  youtu.be/4D7u5KF7SP8  ')).toEqual({
      kind: 'link',
      videoId: '4D7u5KF7SP8',
    });
    // Longer than a search may be: a link is never "too long".
    const long = `https://www.youtube.com/watch?v=4D7u5KF7SP8&list=${'x'.repeat(120)}`;
    expect(jamQueryIntent(long)).toEqual({ kind: 'link', videoId: '4D7u5KF7SP8' });
  });

  it('searches a bare id like any text (an 11-letter word looks the same)', () => {
    expect(jamQueryIntent('programming')).toEqual({ kind: 'search', query: 'programming' });
  });

  it('refuses links to other sites', () => {
    expect(jamQueryIntent('https://music.example.com/track/abc')).toEqual({
      kind: 'foreign_link',
    });
    expect(jamQueryIntent('music.example.com/track/abc')).toEqual({ kind: 'foreign_link' });
    expect(jamQueryIntent('https://www.youtube.com/watch?v=short')).toEqual({
      kind: 'foreign_link',
    });
  });

  it('searches text of 2 to 100 characters, spaces collapsed', () => {
    expect(jamQueryIntent('')).toEqual({ kind: 'empty' });
    expect(jamQueryIntent('   ')).toEqual({ kind: 'empty' });
    expect(jamQueryIntent('a')).toEqual({ kind: 'short' });
    expect(jamQueryIntent('  daft   punk ')).toEqual({ kind: 'search', query: 'daft punk' });
    expect(jamQueryIntent('feat. Pharrell')).toEqual({ kind: 'search', query: 'feat. Pharrell' });
    expect(jamQueryIntent('x'.repeat(100))).toEqual({ kind: 'search', query: 'x'.repeat(100) });
    expect(jamQueryIntent('x'.repeat(101))).toEqual({ kind: 'too_long' });
  });

  it('explains the intents that do not search', () => {
    expect(jamQueryHint({ kind: 'short' })).toBe('Digite pelo menos 2 letras para buscar.');
    expect(jamQueryHint({ kind: 'too_long' })).toBe('Busca muito longa: até 100 caracteres.');
    expect(jamQueryHint({ kind: 'foreign_link' })).toBe('Só links do YouTube ou do YouTube Music.');
    expect(jamQueryHint({ kind: 'empty' })).toBeNull();
    expect(jamQueryHint({ kind: 'search', query: 'daft' })).toBeNull();
    expect(jamQueryHint({ kind: 'link', videoId: '4D7u5KF7SP8' })).toBeNull();
  });
});

describe('track labels', () => {
  it('shows album and duration, or just the duration', () => {
    expect(jamTrackDetail(track)).toBe('Random Access Memories · 6:09');
    expect(jamTrackDetail({ ...track, album: null })).toBe('6:09');
    expect(jamDurationLabel(0)).toBe('–:––');
  });

  it('joins title and artists', () => {
    expect(jamTrackLine(track)).toBe('Get Lucky — Daft Punk, Pharrell Williams');
    expect(jamTrackLine({ ...track, artists: '' })).toBe('Get Lucky');
  });
});

describe('people', () => {
  it('resolves names from presence, you, or the id', () => {
    expect(jamPerson('ana', profiles, self)).toEqual({
      id: 'ana',
      name: 'Ana',
      avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
      self: false,
    });
    expect(jamPerson('eu', profiles, self)).toEqual({
      id: 'eu',
      name: 'Eu Mesmo',
      avatarUrl: null,
      self: true,
    });
    expect(jamPerson('zeca', profiles, self)).toEqual({
      id: 'zeca',
      name: 'zeca',
      avatarUrl: null,
      self: false,
    });
  });

  it('says who asked for it and who paused it', () => {
    const ana = jamPerson('ana', profiles, self);
    const me = jamPerson('eu', profiles, self);
    expect(requestedByLabel(ana)).toBe('Pedida por Ana');
    expect(requestedByLabel(me)).toBe('Pedida por você');
    expect(pausedByLabel(ana)).toBe('Pausada por Ana');
    expect(pausedByLabel(me)).toBe('Pausada por você');
    expect(pausedByLabel(null)).toBe('Pausada');
  });
});

describe('queue', () => {
  it('says where your own songs are and that the others are downloading', () => {
    expect(jamItemStatusLabel(item('a', 'eu', 'downloading'), upload('a', 'preparing'))).toBe(
      'Preparando…',
    );
    expect(jamItemStatusLabel(item('a', 'eu', 'downloading'), upload('a', 'downloading'))).toBe(
      'Baixando…',
    );
    expect(jamItemStatusLabel(item('a', 'eu', 'downloading'), upload('a', 'uploading'))).toBe(
      'Enviando…',
    );
    // All sent: the server has it, even before its "ready" arrives.
    expect(jamItemStatusLabel(item('a', 'eu', 'downloading'), upload('a', 'done'))).toBeNull();
    expect(jamItemStatusLabel(item('a', 'eu', 'ready'), upload('a', 'done'))).toBeNull();
    // Gave up: main takes it off the queue; until then it is still on its way.
    expect(jamItemStatusLabel(item('a', 'eu', 'downloading'), upload('a', 'error'))).toBe(
      'Baixando…',
    );
    expect(jamItemStatusLabel(item('b', 'ana', 'downloading'))).toBe('Baixando…');
    expect(jamItemStatusLabel(item('b', 'ana', 'ready'))).toBeNull();
    // Another song's status never applies.
    expect(jamItemStatusLabel(item('b', 'ana', 'ready'), upload('a', 'uploading'))).toBeNull();
    expect(jamItemStatusLabel(item('b', 'ana', 'downloading'), upload('a', 'done'))).toBe(
      'Baixando…',
    );
  });

  it('shows no badge once the server marks it ready, while the audio still streams in', () => {
    // Streamed: the song may already play while your app is still sending the rest.
    expect(jamItemStatusLabel(item('a', 'eu', 'ready'), upload('a', 'uploading'))).toBeNull();
    expect(jamItemStatusLabel(item('a', 'eu', 'ready'), upload('a', 'downloading'))).toBeNull();
    expect(jamItemStatusLabel(item('a', 'eu', 'ready'), upload('a', 'preparing'))).toBeNull();
  });

  it('never shows "Baixando…" for a song added already ready (cached or prefetched)', () => {
    const added = jamAddedStatus('sala-1', item('a', 'eu', 'ready'));
    expect(added).toEqual({
      itemId: 'a',
      room: 'sala-1',
      title: 'Música a',
      state: 'done',
      message: null,
    });
    // Even a late state still saying "downloading" (or a stray status from main) shows nothing.
    const noted = new Map(added ? [[added.itemId, added]] : []);
    const uploads = withAddedStatuses(new Map([['a', upload('a', 'uploading')]]), noted);
    expect(jamItemStatusLabel(item('a', 'eu', 'downloading'), uploads.get('a'))).toBeNull();
    // A song the app still has to send is left to main's statuses.
    expect(jamAddedStatus('sala-1', item('b', 'eu', 'downloading'))).toBeNull();
  });

  it("merges the noted statuses over main's, keeping the same map when none were noted", () => {
    const uploads = new Map([
      ['a', upload('a', 'uploading')],
      ['b', upload('b', 'preparing')],
    ]);
    expect(withAddedStatuses(uploads, new Map())).toBe(uploads);
    const merged = withAddedStatuses(uploads, new Map([['b', upload('b', 'done')]]));
    expect(merged.get('a')?.state).toBe('uploading');
    expect(merged.get('b')?.state).toBe('done');
    expect(uploads.get('b')?.state).toBe('preparing');
  });

  it('builds the rows in play order', () => {
    const person = (id: string): JamPerson => jamPerson(id, profiles, self);
    const uploads = new Map([['b', upload('b', 'uploading')]]);
    const entries = jamQueueEntries([item('a'), item('b', 'eu', 'downloading')], uploads, person);
    expect(entries.map((entry) => [entry.position, entry.item.id, entry.statusLabel])).toEqual([
      [1, 'a', null],
      [2, 'b', 'Enviando…'],
    ]);
    expect(entries[0]?.requester.name).toBe('Ana');
    expect(entries[1]?.requester.self).toBe(true);
  });

  it('previews the first few songs', () => {
    expect(jamQueuePreview([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(jamQueuePreview([1, 2], 3)).toEqual({ shown: [1, 2], more: 0 });
    expect(jamQueuePreview([1, 2], -1)).toEqual({ shown: [], more: 2 });
  });

  it('counts and explains an empty queue', () => {
    expect(jamQueueSummary(0)).toBe('Nenhuma música na fila');
    expect(jamQueueSummary(1)).toBe('1 música na fila');
    expect(jamQueueSummary(3)).toBe('3 músicas na fila');
    expect(jamEmptyQueueText(false)).toBe(
      'Nenhuma música na fila. Busque uma música para começar a Jam.',
    );
    expect(jamEmptyQueueText(true)).toBe('Nenhuma música na fila. Adicione a próxima.');
  });
});

describe('previous song', () => {
  it('goes back to the most recent song played, only once one was', () => {
    const played = state('sala-1', nowPlaying());
    expect(jamPreviousItem({ ...played, history: [item('b'), item('a')] })?.id).toBe('b');
    // Nothing played yet in this Jam, or a server from before the history: no button.
    expect(jamPreviousItem({ ...played, history: [] })).toBeNull();
    expect(jamPreviousItem(played)).toBeNull();
    expect(jamPreviousItem(null)).toBeNull();
    expect(jamPreviousItem(undefined)).toBeNull();
    // Songs still waiting for their audio with nothing playing: the history still counts.
    const waiting = state('sala-1', null, [item('c', 'ana', 'downloading')]);
    expect(jamPreviousItem({ ...waiting, history: [item('b')] })?.id).toBe('b');
  });

  it('names the song in the tooltip', () => {
    expect(jamPreviousTitle(item('b'))).toBe('Voltar para “Música b” (para todos da sala)');
    expect(jamPreviousTitle({ ...item('b'), track: { ...track, title: '  ' } })).toBe(
      'Voltar para a música anterior (para todos da sala)',
    );
  });
});

describe('rooms', () => {
  it('knows when a song starts right away', () => {
    expect(jamRoomIdle(null)).toBe(true);
    expect(jamRoomIdle(undefined)).toBe(true);
    expect(jamRoomIdle(state('sala-1', null))).toBe(true);
    expect(jamRoomIdle(state('sala-1', null, [item('a', 'ana', 'downloading')]))).toBe(false);
    expect(jamRoomIdle(state('sala-1', nowPlaying()))).toBe(false);
    expect(jamAddedMessage('Get Lucky', true)).toBe('Tocando agora: Get Lucky');
    expect(jamAddedMessage('Get Lucky', false)).toBe('Na fila: Get Lucky');
  });

  it('reports a song that could not be sent', () => {
    expect(jamUploadErrorMessage(upload('a', 'error'))).toBe(
      'Não foi possível adicionar “Get Lucky”: O YouTube recusou o download.',
    );
    expect(jamUploadErrorMessage({ ...upload('a', 'error'), message: null })).toBe(
      'Não foi possível adicionar “Get Lucky”: Tente novamente.',
    );
  });

  it('labels the sidebar indicator', () => {
    expect(jamIndicatorLabel(state('sala-1', nowPlaying()))).toBe(
      'Jam: Get Lucky — Daft Punk, Pharrell Williams',
    );
    expect(jamIndicatorLabel(state('sala-1', null, [item('a', 'ana', 'downloading')]))).toBe(
      'Jam: preparando a primeira música',
    );
    expect(jamIndicatorLabel(state('sala-1', null))).toBeNull();
    expect(jamIndicatorLabel(null)).toBeNull();
  });

  it('sums up the Jam indicator and bounces its bars only while a song plays', () => {
    expect(jamIndicatorSummary('Jam: Get Lucky', false)).toBe('Jam: Get Lucky');
    expect(jamIndicatorSummary('Jam: Get Lucky', true)).toBe('Jam: Get Lucky · ouvindo');
    expect(jamPlaying(state('sala-1', nowPlaying()))).toBe(true);
    expect(jamPlaying(state('sala-1', nowPlaying({ paused: true, pausedBy: 'ana' })))).toBe(false);
    expect(jamPlaying(state('sala-1', null, [item('a', 'ana', 'downloading')]))).toBe(false);
    expect(jamPlaying(null)).toBe(false);
  });

  it('lists the Jams elsewhere in the sidebar order', () => {
    const rooms = {
      'sala-3': state('sala-3', nowPlaying()),
      'sala-1': state('sala-1', nowPlaying()),
      extra: state('extra', null, [item('a')]),
      'sala-2': state('sala-2', null),
    };
    const order = ['sala-1', 'sala-2', 'sala-3'];
    expect(jamsElsewhere(rooms, order, 'sala-1', true).map((jam) => jam.room)).toEqual([
      'sala-3',
      'extra',
    ]);
    // Not connected (yet): your room's Jam is listened to by entering it too.
    expect(jamsElsewhere(rooms, order, 'sala-1', false).map((jam) => jam.room)).toEqual([
      'sala-1',
      'sala-3',
      'extra',
    ]);
  });

  it('keeps the room Jam listened to between songs, only while connected to it', () => {
    const rooms = { 'sala-1': state('sala-1', nowPlaying()), 'sala-2': state('sala-2', null) };
    expect(jamListenable(true, rooms, 'sala-1', true)).toEqual([JAM_BOT_IDENTITY]);
    expect(jamListenable(true, rooms, 'sala-1', true)).toBe(
      jamListenable(true, rooms, 'sala-1', true),
    );
    expect(jamListenable(true, rooms, 'sala-1', false)).toEqual([]);
    expect(jamListenable(true, rooms, 'sala-2', true)).toEqual([]);
    expect(jamListenable(true, rooms, 'sala-3', true)).toEqual([]);
    expect(jamListenable(true, rooms, null, true)).toEqual([]);
    expect(jamListenable(false, rooms, 'sala-1', true)).toEqual([]);
  });
});

describe('createJamPrefetcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const sent: string[] = [];
    const prefetcher = createJamPrefetcher((videoId) => sent.push(videoId));
    return { sent, prefetcher };
  }

  it('prefetches a result that stays hovered or focused for the delay', () => {
    const { sent, prefetcher } = setup();
    prefetcher.intend('aaaaaaaaaaa');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['aaaaaaaaaaa']);
  });

  it('skips results the pointer only crosses (debounced on the last one)', () => {
    const { sent, prefetcher } = setup();
    prefetcher.intend('aaaaaaaaaaa');
    vi.advanceTimersByTime(100);
    prefetcher.intend('bbbbbbbbbbb');
    vi.advanceTimersByTime(100);
    prefetcher.intend('ccccccccccc');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    expect(sent).toEqual(['ccccccccccc']);
  });

  it('drops a result left before the delay, and only that one', () => {
    const { sent, prefetcher } = setup();
    prefetcher.intend('aaaaaaaaaaa');
    prefetcher.cancel('bbbbbbbbbbb');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    expect(sent).toEqual(['aaaaaaaaaaa']);
    prefetcher.intend('bbbbbbbbbbb');
    prefetcher.cancel('bbbbbbbbbbb');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    expect(sent).toEqual(['aaaaaaaaaaa']);
  });

  it('asks for each song at most once per dialog', () => {
    const { sent, prefetcher } = setup();
    prefetcher.intend('aaaaaaaaaaa');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    prefetcher.intend('aaaaaaaaaaa');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    prefetcher.now('aaaaaaaaaaa');
    // Hovering it again while it waits does not restart the delay.
    prefetcher.intend('bbbbbbbbbbb');
    vi.advanceTimersByTime(100);
    prefetcher.intend('bbbbbbbbbbb');
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS - 100);
    expect(sent).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  });

  it('sends a pasted link right away, replacing a pending hover of the same song', () => {
    const { sent, prefetcher } = setup();
    prefetcher.intend('aaaaaaaaaaa');
    prefetcher.now('aaaaaaaaaaa');
    expect(sent).toEqual(['aaaaaaaaaaa']);
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    expect(sent).toEqual(['aaaaaaaaaaa']);
  });

  it('drops the pending one when the dialog closes', () => {
    const { sent, prefetcher } = setup();
    prefetcher.intend('aaaaaaaaaaa');
    prefetcher.clear();
    vi.advanceTimersByTime(JAM_PREFETCH_DELAY_MS);
    expect(sent).toEqual([]);
  });
});
