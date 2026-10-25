import { describe, expect, it } from 'vitest';
import {
  applyJamEvent,
  isAuxiliaryIdentity,
  isJamBotIdentity,
  JAM_BOT_IDENTITY,
  jamPositionAt,
  parseYouTubeVideoId,
  type JamItem,
  type JamNowPlaying,
  type JamSnapshot,
  type JamState,
} from './index';

const item: JamItem = {
  id: 'item-1',
  track: {
    videoId: '4D7u5KF7SP8',
    title: 'Get Lucky',
    artists: 'Daft Punk, Pharrell Williams',
    album: 'Random Access Memories',
    durationMs: 370_000,
    artworkUrl: null,
  },
  requestedBy: 'bryan',
  addedAt: 1_000,
  status: 'ready',
};

const playing: JamNowPlaying = {
  item,
  positionMs: 10_000,
  at: 50_000,
  paused: false,
  pausedBy: null,
};

describe('jam bot identity', () => {
  it('is neither a user id nor an auxiliary identity', () => {
    expect(isJamBotIdentity(JAM_BOT_IDENTITY)).toBe(true);
    expect(isJamBotIdentity('bryan')).toBe(false);
    expect(isAuxiliaryIdentity(JAM_BOT_IDENTITY)).toBe(false);
    expect(/^[a-z0-9][a-z0-9_-]{1,31}$/.test(JAM_BOT_IDENTITY)).toBe(false);
  });
});

describe('applyJamEvent', () => {
  const empty: JamSnapshot = { available: true, rooms: {}, serverTime: 0 };
  const state: JamState = { room: 'sala-1', current: playing, queue: [] };

  it('replaces the snapshot', () => {
    const data: JamSnapshot = { available: false, rooms: {}, serverTime: 5 };
    expect(applyJamEvent(empty, { type: 'jam_snapshot', data })).toBe(data);
  });

  it('replaces a room and drops it once empty', () => {
    const withRoom = applyJamEvent(empty, { type: 'jam_updated', state, serverTime: 7 });
    expect(withRoom.rooms['sala-1']).toBe(state);
    expect(withRoom.serverTime).toBe(7);
    expect(withRoom.available).toBe(true);
    expect(empty.rooms).toEqual({});

    const ended = applyJamEvent(withRoom, {
      type: 'jam_updated',
      state: { room: 'sala-1', current: null, queue: [] },
      serverTime: 9,
    });
    expect(ended.rooms).toEqual({});
  });

  it('keeps a room with playback history while the session lingers', () => {
    const history = { ...item, id: 'history-1' };
    const lingering = applyJamEvent(empty, {
      type: 'jam_updated',
      state: { room: 'sala-1', current: null, queue: [], history: [history] },
      serverTime: 9,
    });
    expect(lingering.rooms['sala-1']).toEqual({
      room: 'sala-1',
      current: null,
      queue: [],
      history: [history],
    });
  });

  it('keeps a room with only a queue', () => {
    const queued = applyJamEvent(empty, {
      type: 'jam_updated',
      state: { room: 'sala-2', current: null, queue: [item] },
      serverTime: 1,
    });
    expect(Object.keys(queued.rooms)).toEqual(['sala-2']);
  });
});

describe('jamPositionAt', () => {
  it('advances while playing', () => {
    expect(jamPositionAt(playing, 52_500)).toBe(12_500);
  });

  it('is frozen while paused', () => {
    expect(jamPositionAt({ ...playing, paused: true, pausedBy: 'ana' }, 99_000)).toBe(10_000);
  });

  it('stays within the song', () => {
    expect(jamPositionAt(playing, 10_000_000)).toBe(370_000);
    expect(jamPositionAt({ ...playing, positionMs: 0 }, 0)).toBe(0);
  });
});

describe('parseYouTubeVideoId', () => {
  it.each([
    ['4D7u5KF7SP8', '4D7u5KF7SP8'],
    ['  4D7u5KF7SP8 ', '4D7u5KF7SP8'],
    ['https://music.youtube.com/watch?v=4D7u5KF7SP8&si=abc', '4D7u5KF7SP8'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1', 'dQw4w9WgXcQ'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('reads %s', (input, expected) => {
    expect(parseYouTubeVideoId(input)).toBe(expected);
  });

  it.each([
    '',
    'daft punk',
    'dQw4w9WgXc',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/dQw4w9WgXcQ',
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
  ])('rejects %s', (input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });
});
