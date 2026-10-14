import { describe, expect, it } from 'vitest';
import {
  applyPresenceEvent,
  AUXILIARY_IDENTITY_SEPARATOR,
  auxiliaryIdentity,
  isAuxiliaryIdentity,
  QUALITY_PRESETS,
  ROOM_ID_PATTERN,
  roomLabel,
  type PresenceParticipant,
  type PresenceSnapshot,
} from './index';

describe('auxiliary identities', () => {
  it('derives the pop-out identity from the user id', () => {
    expect(auxiliaryIdentity('bryan', 'popout')).toBe('bryan~popout');
    expect(auxiliaryIdentity('bryan', 'popout')).toBe(`bryan${AUXILIARY_IDENTITY_SEPARATOR}popout`);
  });

  it('recognises auxiliary identities and leaves regular ids alone', () => {
    expect(isAuxiliaryIdentity(auxiliaryIdentity('ana', 'popout'))).toBe(true);
    expect(isAuxiliaryIdentity('bryan~popout')).toBe(true);
    expect(isAuxiliaryIdentity('bryan')).toBe(false);
    expect(isAuxiliaryIdentity('bryan-popout')).toBe(false);
    expect(isAuxiliaryIdentity('')).toBe(false);
  });

  it('uses a separator that can never appear in a user or room id', () => {
    expect(ROOM_ID_PATTERN.test(`a${AUXILIARY_IDENTITY_SEPARATOR}b`)).toBe(false);
  });
});

describe('QUALITY_PRESETS', () => {
  it('caps the frame rate and bitrate per preset', () => {
    expect(QUALITY_PRESETS.light).toMatchObject({ height: 720, fps: 30, maxBitrate: 2_500_000 });
    expect(QUALITY_PRESETS.standard).toMatchObject({
      height: 1080,
      fps: 30,
      maxBitrate: 4_000_000,
    });
    expect(QUALITY_PRESETS.game).toMatchObject({ height: 1080, fps: 60, maxBitrate: 6_000_000 });
  });
});

describe('ROOM_ID_PATTERN', () => {
  it('accepts simple room ids and rejects the rest', () => {
    expect(ROOM_ID_PATTERN.test('geral')).toBe(true);
    expect(ROOM_ID_PATTERN.test('jogos-2')).toBe(true);
    expect(ROOM_ID_PATTERN.test('-x')).toBe(false);
    expect(ROOM_ID_PATTERN.test('sala com espaço')).toBe(false);
    expect(ROOM_ID_PATTERN.test('a'.repeat(33))).toBe(false);
  });
});

describe('applyPresenceEvent', () => {
  const ana: PresenceParticipant = { id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 };
  const beto: PresenceParticipant = { id: 'beto', name: 'Beto', streaming: true, joinedAt: 2 };
  const base: PresenceSnapshot = { rooms: { geral: [ana], jogos: [] } };

  it('replaces everything on snapshot', () => {
    const next = applyPresenceEvent(base, { type: 'snapshot', data: { rooms: { filme: [beto] } } });
    expect(next).toEqual({ rooms: { filme: [beto] } });
  });

  it('adds a participant without duplicating and without mutating the input', () => {
    const next = applyPresenceEvent(base, {
      type: 'participant_joined',
      room: 'geral',
      participant: beto,
    });
    expect(next.rooms.geral).toEqual([ana, beto]);
    const again = applyPresenceEvent(next, {
      type: 'participant_joined',
      room: 'geral',
      participant: { ...beto, name: 'Beto 2' },
    });
    expect(again.rooms.geral?.map((p) => p.name)).toEqual(['Ana', 'Beto 2']);
    expect(base.rooms.geral).toEqual([ana]);
  });

  it('creates the room when a participant joins an unknown room', () => {
    const next = applyPresenceEvent(base, {
      type: 'participant_joined',
      room: 'nova',
      participant: ana,
    });
    expect(next.rooms.nova).toEqual([ana]);
  });

  it('removes a participant on leave', () => {
    const next = applyPresenceEvent(base, {
      type: 'participant_left',
      room: 'geral',
      participant: ana,
    });
    expect(next.rooms.geral).toEqual([]);
  });

  it('toggles streaming on stream events', () => {
    const started = applyPresenceEvent(base, {
      type: 'stream_started',
      room: 'geral',
      participantId: 'ana',
    });
    expect(started.rooms.geral?.[0]?.streaming).toBe(true);
    const stopped = applyPresenceEvent(started, {
      type: 'stream_stopped',
      room: 'geral',
      participantId: 'ana',
    });
    expect(stopped.rooms.geral?.[0]?.streaming).toBe(false);
  });

  it('ignores stream events for unknown participants', () => {
    const next = applyPresenceEvent(base, {
      type: 'stream_started',
      room: 'geral',
      participantId: 'ghost',
    });
    expect(next.rooms.geral).toEqual([ana]);
  });
});

describe('roomLabel', () => {
  it('turns room ids into readable labels', () => {
    expect(roomLabel('sala-1')).toBe('Sala 1');
    expect(roomLabel('jogos_fds')).toBe('Jogos fds');
    expect(roomLabel('geral')).toBe('Geral');
  });
});
