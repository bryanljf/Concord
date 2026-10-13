import { beforeEach, describe, expect, it } from 'vitest';
import type { PresenceEvent } from '@concord/shared';
import { PresenceStore } from '../src/presence-store';
import type { ResolvedProfile } from '../src/profiles';

// avatarUrl: null is what presence reports when no profile is known.
const alice = { id: 'alice', name: 'Alice', joinedAt: 1_000, avatarUrl: null };
const bob = { id: 'bob', name: 'Bob', joinedAt: 2_000, avatarUrl: null };
const carol = { id: 'carol', name: 'Carol', joinedAt: 3_000, avatarUrl: null };

describe('PresenceStore', () => {
  let store: PresenceStore;
  let events: PresenceEvent[];

  beforeEach(() => {
    store = new PresenceStore(['geral', 'jogos']);
    events = [];
    store.subscribe((event) => events.push(event));
  });

  it('starts with every configured room empty', () => {
    expect(store.snapshot()).toEqual({ rooms: { geral: [], jogos: [] } });
  });

  it('emits participant_joined once for repeated joins and refreshes the name', () => {
    store.join('geral', alice);
    store.join('geral', { ...alice, name: 'Alice (PC)' });
    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: { ...alice, streaming: false } },
    ]);
    expect(store.snapshot().rooms.geral).toEqual([
      { ...alice, name: 'Alice (PC)', streaming: false },
    ]);
  });

  it('emits participant_left and forgets the participant', () => {
    store.join('geral', alice);
    store.leave('geral', 'alice');
    expect(events[1]).toEqual({
      type: 'participant_left',
      room: 'geral',
      participant: { ...alice, streaming: false },
    });
    expect(store.participant('geral', 'alice')).toBeUndefined();
    expect(store.snapshot().rooms.geral).toEqual([]);
  });

  it('ignores leaves and unpublishes for unknown participants', () => {
    store.leave('geral', 'ghost');
    store.leave('nowhere', 'ghost');
    store.screenTrackUnpublished('geral', 'ghost', 'TR_1');
    expect(events).toEqual([]);
  });

  it('emits stream_stopped before participant_left when a streaming participant leaves', () => {
    store.join('geral', alice);
    store.screenTrackPublished('geral', alice, 'TR_1');
    events.length = 0;
    store.leave('geral', 'alice');
    expect(events).toEqual([
      { type: 'stream_stopped', room: 'geral', participantId: 'alice' },
      { type: 'participant_left', room: 'geral', participant: { ...alice, streaming: true } },
    ]);
  });

  it('reports streaming while at least one screen track is published', () => {
    store.join('geral', alice);
    store.screenTrackPublished('geral', alice, 'TR_1');
    store.screenTrackPublished('geral', alice, 'TR_2');
    store.screenTrackUnpublished('geral', 'alice', 'TR_1');
    store.screenTrackUnpublished('geral', 'alice', 'TR_unknown');
    expect(events.slice(1)).toEqual([
      { type: 'stream_started', room: 'geral', participantId: 'alice' },
    ]);
    expect(store.participant('geral', 'alice')?.streaming).toBe(true);

    store.screenTrackUnpublished('geral', 'alice', 'TR_2');
    expect(events.at(-1)).toEqual({
      type: 'stream_stopped',
      room: 'geral',
      participantId: 'alice',
    });
    expect(store.participant('geral', 'alice')?.streaming).toBe(false);
  });

  it('creates the participant when a screen track arrives before the join', () => {
    store.screenTrackPublished('jogos', bob, 'TR_9');
    expect(events).toEqual([
      { type: 'participant_joined', room: 'jogos', participant: { ...bob, streaming: false } },
      { type: 'stream_started', room: 'jogos', participantId: 'bob' },
    ]);
  });

  it('clearRoom removes everyone but keeps configured rooms in the snapshot', () => {
    store.join('geral', alice);
    store.join('geral', bob);
    store.screenTrackPublished('geral', bob, 'TR_1');
    events.length = 0;
    store.clearRoom('geral');
    store.clearRoom('geral');
    expect(events.map((event) => event.type)).toEqual([
      'participant_left',
      'stream_stopped',
      'participant_left',
    ]);
    expect(store.snapshot()).toEqual({ rooms: { geral: [], jogos: [] } });
  });

  describe('with a profile resolver', () => {
    let profiles: Map<string, ResolvedProfile>;
    let resolved: PresenceStore;

    beforeEach(() => {
      profiles = new Map([['alice', { name: 'Alice D.', avatarUrl: 'https://a/1.png' }]]);
      resolved = new PresenceStore(['geral', 'jogos'], (id) => profiles.get(id));
      events = [];
      resolved.subscribe((event) => events.push(event));
    });

    it('shows the resolved name and avatar, falling back to the LiveKit name', () => {
      resolved.join('geral', alice);
      resolved.join('geral', bob);
      expect(resolved.snapshot().rooms.geral).toEqual([
        { ...alice, name: 'Alice D.', avatarUrl: 'https://a/1.png', streaming: false },
        { ...bob, streaming: false },
      ]);
    });

    it('refreshUser emits participant_updated in every room where the user is present', () => {
      resolved.join('geral', alice);
      resolved.screenTrackPublished('jogos', alice, 'TR_1');
      resolved.join('geral', bob);
      events.length = 0;

      profiles.set('alice', { name: 'Lice', avatarUrl: 'https://a/2.png' });
      resolved.refreshUser('alice');
      expect(events).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, name: 'Lice', avatarUrl: 'https://a/2.png', streaming: false },
        },
        {
          type: 'participant_updated',
          room: 'jogos',
          participant: { ...alice, name: 'Lice', avatarUrl: 'https://a/2.png', streaming: true },
        },
      ]);
      expect(resolved.participant('jogos', 'alice')?.name).toBe('Lice');
    });

    it('refreshUser is silent when nothing visible changed or the user is absent', () => {
      resolved.join('geral', alice);
      events.length = 0;
      resolved.refreshUser('alice');
      resolved.refreshUser('ghost');
      expect(events).toEqual([]);
    });

    it('falls back to the LiveKit name when the profile disappears', () => {
      resolved.join('geral', alice);
      events.length = 0;
      profiles.delete('alice');
      resolved.refreshAll();
      expect(events).toEqual([
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
    });
  });

  describe('replaceAll', () => {
    it('emits only the differences from the current state', () => {
      store.join('geral', alice);
      store.screenTrackPublished('geral', alice, 'TR_1');
      store.join('geral', bob);
      store.join('jogos', carol);
      events.length = 0;

      const dave = { id: 'dave', name: 'Dave', joinedAt: 4_000, avatarUrl: null };
      store.replaceAll({
        geral: [
          { ...alice, screenTracks: ['TR_1'] },
          { ...dave, screenTracks: ['TR_4'] },
        ],
      });

      expect(events).toEqual([
        { type: 'participant_left', room: 'jogos', participant: { ...carol, streaming: false } },
        { type: 'participant_left', room: 'geral', participant: { ...bob, streaming: false } },
        { type: 'participant_joined', room: 'geral', participant: { ...dave, streaming: false } },
        { type: 'stream_started', room: 'geral', participantId: 'dave' },
      ]);
      expect(store.snapshot().rooms).toEqual({
        geral: [
          { ...alice, streaming: true },
          { ...dave, streaming: true },
        ],
        jogos: [],
      });
    });

    it('is silent when nothing changed', () => {
      const state = {
        geral: [{ ...alice, screenTracks: ['TR_1'] }],
        jogos: [{ ...bob, screenTracks: [] }],
      };
      store.replaceAll(state);
      events.length = 0;
      store.replaceAll(state);
      expect(events).toEqual([]);
    });

    it('stops streams whose tracks disappeared', () => {
      store.replaceAll({ geral: [{ ...alice, screenTracks: ['TR_1'] }] });
      events.length = 0;
      store.replaceAll({ geral: [{ ...alice, screenTracks: [] }] });
      expect(events).toEqual([{ type: 'stream_stopped', room: 'geral', participantId: 'alice' }]);
    });

    it('clears rooms missing from the new state, including unconfigured ones', () => {
      store.join('secret', alice);
      expect(store.snapshot().rooms.secret).toHaveLength(1);
      events.length = 0;
      store.replaceAll({});
      expect(events).toEqual([
        { type: 'participant_left', room: 'secret', participant: { ...alice, streaming: false } },
      ]);
      expect(store.snapshot()).toEqual({ rooms: { geral: [], jogos: [] } });
    });
  });
});
