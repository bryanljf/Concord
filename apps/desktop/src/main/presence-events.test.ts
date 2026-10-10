import { describe, expect, it } from 'vitest';
import { parsePresenceEvent } from './presence-events';

const ana = { id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 };

describe('parsePresenceEvent', () => {
  it('accepts every event type', () => {
    expect(parsePresenceEvent({ type: 'snapshot', data: { rooms: { geral: [ana] } } })).toEqual({
      type: 'snapshot',
      data: { rooms: { geral: [ana] } },
    });
    expect(
      parsePresenceEvent({ type: 'participant_joined', room: 'geral', participant: ana }),
    ).toEqual({ type: 'participant_joined', room: 'geral', participant: ana });
    expect(
      parsePresenceEvent({ type: 'participant_left', room: 'geral', participant: ana }),
    ).toEqual({ type: 'participant_left', room: 'geral', participant: ana });
    expect(
      parsePresenceEvent({ type: 'stream_started', room: 'jogos', participantId: 'ana' }),
    ).toEqual({ type: 'stream_started', room: 'jogos', participantId: 'ana' });
    expect(
      parsePresenceEvent({ type: 'stream_stopped', room: 'jogos', participantId: 'ana' }),
    ).toEqual({ type: 'stream_stopped', room: 'jogos', participantId: 'ana' });
  });

  it('drops unknown fields from participants', () => {
    const event = parsePresenceEvent({
      type: 'participant_joined',
      room: 'geral',
      participant: { ...ana, extra: true },
    });
    expect(event).toEqual({ type: 'participant_joined', room: 'geral', participant: ana });
  });

  it('rejects malformed payloads', () => {
    expect(parsePresenceEvent(null)).toBeNull();
    expect(parsePresenceEvent('snapshot')).toBeNull();
    expect(parsePresenceEvent({ type: 'unknown' })).toBeNull();
    expect(parsePresenceEvent({ type: 'snapshot' })).toBeNull();
    expect(
      parsePresenceEvent({ type: 'snapshot', data: { rooms: { geral: [{ id: 1 }] } } }),
    ).toBeNull();
    expect(parsePresenceEvent({ type: 'snapshot', data: { rooms: { geral: 'nope' } } })).toBeNull();
    expect(parsePresenceEvent({ type: 'participant_joined', participant: ana })).toBeNull();
    expect(parsePresenceEvent({ type: 'stream_started', room: 'jogos' })).toBeNull();
    expect(
      parsePresenceEvent({ type: 'stream_started', room: 1, participantId: 'ana' }),
    ).toBeNull();
  });
});
