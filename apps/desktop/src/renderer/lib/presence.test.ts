import { describe, expect, it } from 'vitest';
import type { PresenceParticipant, PresenceSnapshot } from '@telao/shared';
import {
  knownParticipants,
  mergeRoomIds,
  participantsOf,
  resolveFocus,
  sortParticipants,
  statusLabel,
  statusShortLabel,
  statusTone,
  streamersOf,
} from './presence';

const ana: PresenceParticipant = { id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 };
const beto: PresenceParticipant = { id: 'beto', name: 'Beto', streaming: true, joinedAt: 2 };
const carla: PresenceParticipant = { id: 'carla', name: 'Carla', streaming: true, joinedAt: 3 };
const eric: PresenceParticipant = { id: 'eric', name: 'Éric', streaming: false, joinedAt: 4 };

const snapshot: PresenceSnapshot = {
  rooms: { jogos: [eric, carla, ana, beto], geral: [], extra: [ana] },
};

describe('sortParticipants / participantsOf', () => {
  it('puts streamers first, then sorts by name with pt-BR collation', () => {
    expect(sortParticipants([eric, carla, ana, beto]).map((p) => p.id)).toEqual([
      'beto',
      'carla',
      'ana',
      'eric',
    ]);
    expect(participantsOf(snapshot, 'nope')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = [eric, ana];
    sortParticipants(input);
    expect(input.map((p) => p.id)).toEqual(['eric', 'ana']);
  });
});

describe('streamersOf', () => {
  it('keeps only streaming participants', () => {
    expect(streamersOf(snapshot, 'jogos').map((p) => p.id)).toEqual(['beto', 'carla']);
    expect(streamersOf(snapshot, 'geral')).toEqual([]);
  });
});

describe('knownParticipants', () => {
  it('deduplicates across rooms and sorts by name', () => {
    expect(knownParticipants(snapshot).map((p) => p.id)).toEqual(['ana', 'beto', 'carla', 'eric']);
  });
});

describe('mergeRoomIds', () => {
  it('keeps API order and appends unknown presence rooms alphabetically', () => {
    expect(mergeRoomIds(['geral', 'jogos'], snapshot)).toEqual(['geral', 'jogos', 'extra']);
    expect(mergeRoomIds([], snapshot)).toEqual(['extra', 'geral', 'jogos']);
    expect(mergeRoomIds(['filme'], { rooms: {} })).toEqual(['filme']);
  });
});

describe('resolveFocus', () => {
  it('honours the request only while that participant streams', () => {
    expect(resolveFocus([beto, carla], 'carla')).toBe('carla');
    expect(resolveFocus([beto, carla], 'ana')).toBe('beto');
    expect(resolveFocus([beto, carla], null)).toBe('beto');
    expect(resolveFocus([], 'beto')).toBe(null);
  });
});

describe('status helpers', () => {
  it('maps every state to a tone and pt-BR labels', () => {
    expect(statusTone({ state: 'connected' })).toBe('online');
    expect(statusLabel({ state: 'connected' })).toBe('Conectado');

    expect(statusTone({ state: 'connecting', attempt: 3 })).toBe('connecting');
    expect(statusLabel({ state: 'connecting', attempt: 3 })).toBe('Reconectando… (tentativa 3)');
    expect(statusLabel({ state: 'connecting', attempt: 1 })).toBe('Conectando…');
    expect(statusShortLabel({ state: 'connecting', attempt: 3 })).toBe('Reconectando…');

    expect(statusTone({ state: 'error', message: 'Servidor fora do ar', retryInMs: 5000 })).toBe(
      'error',
    );
    expect(statusLabel({ state: 'error', message: 'Servidor fora do ar', retryInMs: 5000 })).toBe(
      'Servidor fora do ar — nova tentativa em 5 s',
    );
    expect(statusShortLabel({ state: 'error', message: 'x', retryInMs: 1 })).toBe('Sem conexão');

    expect(statusTone({ state: 'idle', reason: 'discord_closed' })).toBe('idle');
    expect(statusLabel({ state: 'idle', reason: 'discord_closed' })).toBe(
      'Discord fechado — presença pausada',
    );
    expect(statusShortLabel({ state: 'idle', reason: 'no_session' })).toBe('Desconectado');
  });
});
