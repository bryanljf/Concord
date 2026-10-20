import { describe, expect, it } from 'vitest';
import {
  applyPresenceEvent,
  AUXILIARY_IDENTITY_SEPARATOR,
  auxiliaryIdentity,
  isAuxiliaryIdentity,
  parseStreamQualityId,
  ROOM_ID_PATTERN,
  roomLabel,
  STREAM_FRAME_RATES,
  STREAM_RESOLUTIONS,
  streamQualityId,
  streamQualityOf,
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

describe('stream quality', () => {
  it('keeps the caps of the former presets', () => {
    expect(streamQualityOf('720p30')).toEqual({
      id: '720p30',
      width: 1280,
      height: 720,
      fps: 30,
      maxBitrate: 2_500_000,
    });
    expect(streamQualityOf('1080p30')).toMatchObject({ width: 1920, maxBitrate: 4_000_000 });
    expect(streamQualityOf('1080p60')).toMatchObject({ width: 1920, maxBitrate: 6_000_000 });
  });

  it('covers every resolution from 480p to 1440p at 15, 30 and 60 fps', () => {
    expect(streamQualityOf('480p15')).toMatchObject({ width: 854, height: 480, fps: 15 });
    expect(streamQualityOf('1440p60')).toMatchObject({ width: 2560, height: 1440, fps: 60 });
    for (const resolution of STREAM_RESOLUTIONS) {
      const caps = STREAM_FRAME_RATES.map(
        (fps) => streamQualityOf(streamQualityId(resolution, fps)).maxBitrate,
      );
      // More frames, more bits.
      expect([...caps].sort((a, b) => a - b)).toEqual(caps);
    }
  });

  it('parses ids, maps the former presets and rejects the rest', () => {
    expect(parseStreamQualityId('1440p15')).toBe('1440p15');
    expect(parseStreamQualityId('light')).toBe('720p30');
    expect(parseStreamQualityId('standard')).toBe('1080p30');
    expect(parseStreamQualityId('game')).toBe('1080p60');
    expect(parseStreamQualityId('1080p45')).toBeNull();
    expect(parseStreamQualityId('2160p30')).toBeNull();
    expect(parseStreamQualityId('ultra')).toBeNull();
    expect(parseStreamQualityId('toString')).toBeNull();
    expect(parseStreamQualityId(1080)).toBeNull();
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
