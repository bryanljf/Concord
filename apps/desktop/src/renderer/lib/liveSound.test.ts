import { describe, expect, it } from 'vitest';
import type { PresenceEvent } from '@concord/shared';
import { shouldPlayLiveStarted, type LiveSoundContext } from './liveSound';

const context: LiveSoundContext = {
  currentRoom: 'sala-1',
  connected: true,
  selfId: 'eu',
  mutedRooms: [],
  mutedUsers: [],
};

const started = (room: string, participantId: string): PresenceEvent => ({
  type: 'stream_started',
  room,
  participantId,
});

describe('shouldPlayLiveStarted', () => {
  it('plays when someone else goes live in the room you are in', () => {
    expect(shouldPlayLiveStarted(started('sala-1', 'ana'), context)).toBe(true);
  });

  it('stays quiet for lives in other rooms', () => {
    expect(shouldPlayLiveStarted(started('sala-2', 'ana'), context)).toBe(false);
  });

  it('stays quiet for your own broadcast', () => {
    expect(shouldPlayLiveStarted(started('sala-1', 'eu'), context)).toBe(false);
  });

  it('stays quiet outside a room or while not connected yet', () => {
    expect(shouldPlayLiveStarted(started('sala-1', 'ana'), { ...context, currentRoom: null })).toBe(
      false,
    );
    expect(shouldPlayLiveStarted(started('sala-1', 'ana'), { ...context, connected: false })).toBe(
      false,
    );
  });

  it('respects muted rooms and muted people', () => {
    expect(
      shouldPlayLiveStarted(started('sala-1', 'ana'), { ...context, mutedRooms: ['sala-1'] }),
    ).toBe(false);
    expect(
      shouldPlayLiveStarted(started('sala-1', 'ana'), { ...context, mutedUsers: ['ana'] }),
    ).toBe(false);
    expect(
      shouldPlayLiveStarted(started('sala-1', 'ana'), { ...context, mutedUsers: ['beto'] }),
    ).toBe(true);
  });

  it('ignores everything but live transitions (lives already running when you join)', () => {
    const snapshot: PresenceEvent = {
      type: 'snapshot',
      data: {
        rooms: { 'sala-1': [{ id: 'ana', name: 'Ana', streaming: true, joinedAt: 1 }] },
      },
    };
    const joined: PresenceEvent = {
      type: 'participant_joined',
      room: 'sala-1',
      participant: { id: 'ana', name: 'Ana', streaming: true, joinedAt: 1 },
    };
    const stopped: PresenceEvent = { type: 'stream_stopped', room: 'sala-1', participantId: 'ana' };
    expect(shouldPlayLiveStarted(snapshot, context)).toBe(false);
    expect(shouldPlayLiveStarted(joined, context)).toBe(false);
    expect(shouldPlayLiveStarted(stopped, context)).toBe(false);
  });
});
