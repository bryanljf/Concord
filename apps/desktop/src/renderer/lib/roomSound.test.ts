import { describe, expect, it } from 'vitest';
import type { PresenceEvent } from '@concord/shared';
import { roomSoundFor, type RoomSoundContext } from './roomSound';

const context: RoomSoundContext = { currentRoom: 'sala-1', connected: true, selfId: 'me' };

const presence = (
  type: 'participant_joined' | 'participant_left',
  room: string,
  id: string,
): PresenceEvent => ({
  type,
  room,
  participant: { id, name: id, joinedAt: 0, streaming: false },
});

describe('roomSoundFor', () => {
  it('rings when someone else enters or leaves your room', () => {
    expect(roomSoundFor(presence('participant_joined', 'sala-1', 'ana'), context)).toBe('joined');
    expect(roomSoundFor(presence('participant_left', 'sala-1', 'ana'), context)).toBe('left');
  });

  it('ignores other rooms, yourself and snapshots', () => {
    expect(roomSoundFor(presence('participant_joined', 'sala-2', 'ana'), context)).toBeNull();
    expect(roomSoundFor(presence('participant_left', 'sala-1', 'me'), context)).toBeNull();
    expect(roomSoundFor({ type: 'snapshot', data: { rooms: {} } }, context)).toBeNull();
    expect(
      roomSoundFor({ type: 'stream_started', room: 'sala-1', participantId: 'ana' }, context),
    ).toBeNull();
  });

  it('stays silent while not connected to a room', () => {
    const event = presence('participant_joined', 'sala-1', 'ana');
    expect(roomSoundFor(event, { ...context, connected: false })).toBeNull();
    expect(roomSoundFor(event, { ...context, currentRoom: null })).toBeNull();
  });
});
