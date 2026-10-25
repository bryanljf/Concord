import { JAM_QUEUE_MAX, type JamItem, type JamState } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import {
  isJamPayload,
  JAM_ROOMS_MAX,
  JAM_TEXT_MAX_LENGTH,
  parseArtworkUrl,
  parseJamEvent,
  parseJamItem,
  parseJamTrack,
} from './jam-events';

const artworkUrl = 'https://lh3.googleusercontent.com/abc=w120-h120';

const track = {
  videoId: '4D7u5KF7SP8',
  title: 'Get Lucky',
  artists: 'Daft Punk, Pharrell Williams',
  album: 'Random Access Memories',
  durationMs: 370_000,
  artworkUrl,
};

const item: JamItem = {
  id: 'item-1',
  track,
  requestedBy: 'bryan',
  addedAt: 1_000,
  status: 'ready',
};

const state: JamState = {
  room: 'sala-1',
  current: { item, positionMs: 10_000, at: 50_000, paused: true, pausedBy: 'ana' },
  queue: [{ ...item, id: 'item-2', status: 'downloading' }],
};

describe('parseJamEvent', () => {
  it('accepts both event types', () => {
    const snapshot = {
      type: 'jam_snapshot',
      data: { available: true, rooms: { 'sala-1': state }, serverTime: 60_000 },
    };
    expect(parseJamEvent(snapshot)).toEqual(snapshot);
    const updated = { type: 'jam_updated', state, serverTime: 61_000 };
    expect(parseJamEvent(updated)).toEqual(updated);
    // An ended jam: nothing playing, nothing queued.
    const ended = {
      type: 'jam_updated',
      state: { room: 'sala-1', current: null, queue: [] },
      serverTime: 1,
    };
    expect(parseJamEvent(ended)).toEqual(ended);
  });

  it('drops unknown fields everywhere', () => {
    const event = parseJamEvent({
      type: 'jam_updated',
      extra: 1,
      serverTime: 2,
      state: {
        ...state,
        extra: true,
        current: {
          ...state.current,
          extra: 'x',
          item: { ...item, extra: [], track: { ...track, x: 1 } },
        },
      },
    });
    expect(event).toEqual({ type: 'jam_updated', state, serverTime: 2 });
  });

  it('rejects anything malformed', () => {
    const bad = (value: unknown) => expect(parseJamEvent(value)).toBeNull();
    bad(null);
    bad('jam_snapshot');
    bad({ type: 'snapshot', data: { rooms: {} } });
    bad({ type: 'jam_snapshot', data: { available: 'yes', rooms: {}, serverTime: 1 } });
    bad({ type: 'jam_snapshot', data: { available: true, rooms: [], serverTime: 1 } });
    bad({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: -1 } });
    // The key must be the state's own room.
    bad({
      type: 'jam_snapshot',
      data: { available: true, rooms: { 'sala-2': state }, serverTime: 1 },
    });
    bad({ type: 'jam_updated', state, serverTime: Number.NaN });
    bad({ type: 'jam_updated', state: { ...state, room: 'sala com espaço' }, serverTime: 1 });
    bad({ type: 'jam_updated', state: { ...state, room: '__proto__' }, serverTime: 1 });
    bad({ type: 'jam_updated', state: { ...state, queue: 'none' }, serverTime: 1 });
    bad({ type: 'jam_updated', state: { ...state, queue: [{ ...item, id: '' }] }, serverTime: 1 });
    bad({
      type: 'jam_updated',
      state: { ...state, queue: [{ ...item, status: 'x' }] },
      serverTime: 1,
    });
    bad({
      type: 'jam_updated',
      state: { ...state, queue: [{ ...item, requestedBy: 'Not A User' }] },
      serverTime: 1,
    });
    bad({
      type: 'jam_updated',
      state: { ...state, current: { ...state.current, paused: 1 } },
      serverTime: 1,
    });
    bad({
      type: 'jam_updated',
      state: { ...state, current: { ...state.current, pausedBy: 7 } },
      serverTime: 1,
    });
    bad({ type: 'jam_updated', state: { ...state, current: 'playing' }, serverTime: 1 });
  });

  it('bounds the queue, the rooms and the strings', () => {
    const queue = Array.from({ length: JAM_QUEUE_MAX + 1 }, (_, i) => ({ ...item, id: `i${i}` }));
    expect(
      parseJamEvent({ type: 'jam_updated', state: { ...state, queue }, serverTime: 1 }),
    ).toBeNull();
    expect(
      parseJamEvent({
        type: 'jam_updated',
        state: { ...state, queue: queue.slice(0, JAM_QUEUE_MAX) },
        serverTime: 1,
      }),
    ).not.toBeNull();

    const rooms: Record<string, JamState> = {};
    for (let i = 0; i <= JAM_ROOMS_MAX; i += 1) rooms[`r${i}`] = { ...state, room: `r${i}` };
    expect(
      parseJamEvent({ type: 'jam_snapshot', data: { available: true, rooms, serverTime: 1 } }),
    ).toBeNull();

    expect(parseJamItem({ ...item, id: 'x'.repeat(65) })).toBeNull();
    expect(parseJamItem({ ...item, id: 'a/b' })).toBeNull();
    expect(parseJamTrack({ ...track, title: 'x'.repeat(JAM_TEXT_MAX_LENGTH + 1) })).toBeNull();
  });
});

describe('parseJamTrack', () => {
  it('accepts a track without album or cover', () => {
    expect(parseJamTrack({ ...track, album: null, artworkUrl: null })).toEqual({
      ...track,
      album: null,
      artworkUrl: null,
    });
  });

  it('rejects bad ids, texts and durations', () => {
    expect(parseJamTrack({ ...track, videoId: 'short' })).toBeNull();
    expect(parseJamTrack({ ...track, videoId: '4D7u5KF7SP8&list=x' })).toBeNull();
    expect(parseJamTrack({ ...track, title: 7 })).toBeNull();
    expect(parseJamTrack({ ...track, artists: undefined })).toBeNull();
    expect(parseJamTrack({ ...track, album: undefined })).toBeNull();
    expect(parseJamTrack({ ...track, durationMs: -1 })).toBeNull();
    expect(parseJamTrack({ ...track, durationMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseJamTrack({ ...track, durationMs: '370000' })).toBeNull();
  });

  it('nulls covers outside YouTube image hosts instead of rejecting the track', () => {
    expect(
      parseJamTrack({ ...track, artworkUrl: 'https://evil.example/a.jpg' })?.artworkUrl,
    ).toBeNull();
  });
});

describe('parseArtworkUrl', () => {
  it('keeps https covers on googleusercontent.com and ytimg.com', () => {
    expect(parseArtworkUrl(artworkUrl)).toBe(artworkUrl);
    expect(parseArtworkUrl('https://i.ytimg.com/vi/4D7u5KF7SP8/hqdefault.jpg')).toBe(
      'https://i.ytimg.com/vi/4D7u5KF7SP8/hqdefault.jpg',
    );
    expect(parseArtworkUrl('https://ytimg.com/a.jpg')).toBe('https://ytimg.com/a.jpg');
  });

  it('nulls everything else', () => {
    expect(parseArtworkUrl(null)).toBeNull();
    expect(parseArtworkUrl(42)).toBeNull();
    expect(parseArtworkUrl('http://i.ytimg.com/a.jpg')).toBeNull();
    expect(parseArtworkUrl('https://evilytimg.com/a.jpg')).toBeNull();
    expect(parseArtworkUrl('https://i.ytimg.com.evil.example/a.jpg')).toBeNull();
    expect(parseArtworkUrl('https://user@i.ytimg.com/a.jpg')).toBeNull();
    expect(parseArtworkUrl('https://i.ytimg.com:8443/a.jpg')).toBeNull();
    expect(parseArtworkUrl(`https://i.ytimg.com/${'a'.repeat(2048)}`)).toBeNull();
    expect(parseArtworkUrl('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('isJamPayload', () => {
  it('tells jam events from presence events', () => {
    expect(isJamPayload({ type: 'jam_snapshot' })).toBe(true);
    expect(isJamPayload({ type: 'jam_updated' })).toBe(true);
    expect(isJamPayload({ type: 'snapshot' })).toBe(false);
    expect(isJamPayload({ type: 'jam_other' })).toBe(false);
    expect(isJamPayload(['jam_snapshot'])).toBe(false);
  });
});
