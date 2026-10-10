import { describe, expect, it } from 'vitest';
import {
  applyPresenceEvent,
  QUALITY_PRESETS,
  ROOM_ID_PATTERN,
  type PresenceParticipant,
  type PresenceSnapshot,
} from './index';

describe('QUALITY_PRESETS', () => {
  it('uses motion hint only for the game preset', () => {
    expect(QUALITY_PRESETS.game.contentHint).toBe('motion');
    expect(QUALITY_PRESETS.light.contentHint).toBe('detail');
    expect(QUALITY_PRESETS.standard.contentHint).toBe('detail');
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
