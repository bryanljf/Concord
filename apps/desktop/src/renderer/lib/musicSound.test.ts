import { describe, expect, it } from 'vitest';
import type { JamEvent, JamItem, JamSnapshot, JamState } from '@concord/shared';
import { shouldPlayJamStarted, type MusicSoundContext } from './musicSound';

const context: MusicSoundContext = {
  currentRoom: 'sala-1',
  connected: true,
  selfId: 'eu',
  mutedRooms: [],
  mutedUsers: [],
  enabled: true,
};

describe('shouldPlayJamStarted', () => {
  const item = (id: string, requestedBy: string): JamItem => ({
    id,
    track: {
      videoId: '4D7u5KF7SP8',
      title: 'Get Lucky',
      artists: 'Daft Punk',
      album: null,
      durationMs: 248_000,
      artworkUrl: null,
    },
    requestedBy,
    addedAt: 1,
    status: 'ready',
  });
  const playing = (room: string, requestedBy = 'ana', id = 'a'): JamState => ({
    room,
    current: { item: item(id, requestedBy), positionMs: 0, at: 1, paused: false, pausedBy: null },
    queue: [],
  });
  const waiting = (room: string): JamState => ({
    room,
    current: null,
    queue: [{ ...item('w', 'ana'), status: 'downloading' }],
  });
  const snapshot = (rooms: Record<string, JamState>): JamSnapshot => ({
    available: true,
    rooms,
    serverTime: 1,
  });
  const updatedJam = (state: JamState): JamEvent => ({ type: 'jam_updated', state, serverTime: 2 });

  it('plays when a Jam starts in your room', () => {
    expect(shouldPlayJamStarted(updatedJam(playing('sala-1')), snapshot({}), context)).toBe(true);
    // Only songs on their way before: the first one starting counts too.
    expect(
      shouldPlayJamStarted(
        updatedJam(playing('sala-1')),
        snapshot({ 'sala-1': waiting('sala-1') }),
        context,
      ),
    ).toBe(true);
  });

  it('stays quiet for the next song, a pause or songs still on their way', () => {
    const before = snapshot({ 'sala-1': playing('sala-1', 'ana', 'a') });
    expect(shouldPlayJamStarted(updatedJam(playing('sala-1', 'beto', 'b')), before, context)).toBe(
      false,
    );
    expect(shouldPlayJamStarted(updatedJam(waiting('sala-1')), snapshot({}), context)).toBe(false);
  });

  it('stays quiet for other rooms, your own song and outside a connected room', () => {
    const none = snapshot({});
    expect(shouldPlayJamStarted(updatedJam(playing('sala-2')), none, context)).toBe(false);
    expect(shouldPlayJamStarted(updatedJam(playing('sala-1', 'eu')), none, context)).toBe(false);
    expect(
      shouldPlayJamStarted(updatedJam(playing('sala-1')), none, { ...context, connected: false }),
    ).toBe(false);
    expect(
      shouldPlayJamStarted(updatedJam(playing('sala-1')), none, { ...context, currentRoom: null }),
    ).toBe(false);
  });

  it('respects the switch, muted rooms and muted people', () => {
    const event = updatedJam(playing('sala-1', 'ana'));
    const none = snapshot({});
    expect(shouldPlayJamStarted(event, none, { ...context, enabled: false })).toBe(false);
    expect(shouldPlayJamStarted(event, none, { ...context, mutedRooms: ['sala-1'] })).toBe(false);
    expect(shouldPlayJamStarted(event, none, { ...context, mutedUsers: ['ana'] })).toBe(false);
  });

  it('ignores snapshots', () => {
    const event: JamEvent = {
      type: 'jam_snapshot',
      data: snapshot({ 'sala-1': playing('sala-1') }),
    };
    expect(shouldPlayJamStarted(event, snapshot({}), context)).toBe(false);
  });
});
