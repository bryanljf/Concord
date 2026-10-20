import { describe, expect, it } from 'vitest';
import type { PresenceEvent, PresenceParticipant, PresenceSnapshot } from '@concord/shared';
import { shouldPlayMusicStarted, type MusicSoundContext } from './musicSound';

const context: MusicSoundContext = {
  currentRoom: 'sala-1',
  connected: true,
  selfId: 'eu',
  mutedRooms: [],
  mutedUsers: [],
  enabled: true,
};

const person = (id: string, music?: boolean): PresenceParticipant => ({
  id,
  name: id,
  streaming: false,
  joinedAt: 1,
  ...(music === undefined ? {} : { music }),
});

const before: PresenceSnapshot = {
  rooms: {
    'sala-1': [person('ana', false), person('beto'), person('eu', false), person('caio', true)],
    'sala-2': [person('duda', false)],
  },
};

const updated = (room: string, participant: PresenceParticipant): PresenceEvent => ({
  type: 'participant_updated',
  room,
  participant,
});

describe('shouldPlayMusicStarted', () => {
  it('plays when someone else in your room turns their music on', () => {
    expect(shouldPlayMusicStarted(updated('sala-1', person('ana', true)), before, context)).toBe(
      true,
    );
    // An older server never sent the field: undefined counts as off.
    expect(shouldPlayMusicStarted(updated('sala-1', person('beto', true)), before, context)).toBe(
      true,
    );
  });

  it('stays quiet for music that was already on (only the transition counts)', () => {
    expect(shouldPlayMusicStarted(updated('sala-1', person('caio', true)), before, context)).toBe(
      false,
    );
  });

  it('stays quiet when the music stops or another field changes', () => {
    expect(shouldPlayMusicStarted(updated('sala-1', person('caio', false)), before, context)).toBe(
      false,
    );
    expect(
      shouldPlayMusicStarted(
        updated('sala-1', { ...person('ana', false), camera: true }),
        before,
        context,
      ),
    ).toBe(false);
  });

  it('stays quiet for other rooms, for you and outside a connected room', () => {
    expect(shouldPlayMusicStarted(updated('sala-2', person('duda', true)), before, context)).toBe(
      false,
    );
    expect(shouldPlayMusicStarted(updated('sala-1', person('eu', true)), before, context)).toBe(
      false,
    );
    expect(
      shouldPlayMusicStarted(updated('sala-1', person('ana', true)), before, {
        ...context,
        currentRoom: null,
      }),
    ).toBe(false);
    expect(
      shouldPlayMusicStarted(updated('sala-1', person('ana', true)), before, {
        ...context,
        connected: false,
      }),
    ).toBe(false);
  });

  it('stays quiet for someone the previous snapshot did not know', () => {
    expect(shouldPlayMusicStarted(updated('sala-1', person('zeca', true)), before, context)).toBe(
      false,
    );
    expect(
      shouldPlayMusicStarted(updated('sala-1', person('ana', true)), { rooms: {} }, context),
    ).toBe(false);
  });

  it('respects the switch, muted rooms and muted people', () => {
    const event = updated('sala-1', person('ana', true));
    expect(shouldPlayMusicStarted(event, before, { ...context, enabled: false })).toBe(false);
    expect(shouldPlayMusicStarted(event, before, { ...context, mutedRooms: ['sala-1'] })).toBe(
      false,
    );
    expect(shouldPlayMusicStarted(event, before, { ...context, mutedUsers: ['ana'] })).toBe(false);
    expect(shouldPlayMusicStarted(event, before, { ...context, mutedUsers: ['beto'] })).toBe(true);
  });

  it('ignores snapshots and people arriving with the music already on', () => {
    const snapshot: PresenceEvent = {
      type: 'snapshot',
      data: { rooms: { 'sala-1': [person('ana', true)] } },
    };
    const joined: PresenceEvent = {
      type: 'participant_joined',
      room: 'sala-1',
      participant: person('zeca', true),
    };
    const started: PresenceEvent = { type: 'stream_started', room: 'sala-1', participantId: 'ana' };
    expect(shouldPlayMusicStarted(snapshot, before, context)).toBe(false);
    expect(shouldPlayMusicStarted(joined, before, context)).toBe(false);
    expect(shouldPlayMusicStarted(started, before, context)).toBe(false);
  });
});
