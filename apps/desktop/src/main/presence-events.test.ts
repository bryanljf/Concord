import { describe, expect, it } from 'vitest';
import { parsePresenceEvent } from './presence-events';

// From an older server (no avatarUrl): the parser fills in null.
const ana = { id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 };
const anaParsed = { ...ana, avatarUrl: null };
const avatarUrl = 'https://cdn.discordapp.com/avatars/1/a.png';

describe('parsePresenceEvent', () => {
  it('accepts every event type', () => {
    expect(parsePresenceEvent({ type: 'snapshot', data: { rooms: { geral: [ana] } } })).toEqual({
      type: 'snapshot',
      data: { rooms: { geral: [anaParsed] } },
    });
    expect(
      parsePresenceEvent({ type: 'participant_joined', room: 'geral', participant: ana }),
    ).toEqual({ type: 'participant_joined', room: 'geral', participant: anaParsed });
    expect(
      parsePresenceEvent({ type: 'participant_left', room: 'geral', participant: ana }),
    ).toEqual({ type: 'participant_left', room: 'geral', participant: anaParsed });
    expect(
      parsePresenceEvent({
        type: 'participant_updated',
        room: 'geral',
        participant: { ...ana, name: 'Aninha', avatarUrl },
      }),
    ).toEqual({
      type: 'participant_updated',
      room: 'geral',
      participant: { ...ana, name: 'Aninha', avatarUrl },
    });
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
    expect(event).toEqual({ type: 'participant_joined', room: 'geral', participant: anaParsed });
  });

  it('keeps Discord CDN avatars and nulls anything else', () => {
    const parse = (value: unknown) => {
      const event = parsePresenceEvent({
        type: 'participant_joined',
        room: 'geral',
        participant: { ...ana, avatarUrl: value },
      });
      return event?.type === 'participant_joined' ? event.participant.avatarUrl : 'rejected';
    };
    expect(parse(avatarUrl)).toBe(avatarUrl);
    expect(parse(null)).toBeNull();
    expect(parse(42)).toBeNull();
    expect(parse('https://evil.example/a.png')).toBeNull();
    expect(parse('http://cdn.discordapp.com/a.png')).toBeNull();
    expect(parse('data:image/png;base64,AAAA')).toBeNull();
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
    expect(parsePresenceEvent({ type: 'participant_updated', room: 'geral' })).toBeNull();
    expect(
      parsePresenceEvent({ type: 'participant_updated', room: 'geral', participant: { id: 'a' } }),
    ).toBeNull();
    expect(parsePresenceEvent({ type: 'stream_started', room: 'jogos' })).toBeNull();
    expect(
      parsePresenceEvent({ type: 'stream_started', room: 1, participantId: 'ana' }),
    ).toBeNull();
  });
});
