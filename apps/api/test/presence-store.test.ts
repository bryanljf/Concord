import { beforeEach, describe, expect, it } from 'vitest';
import type { PresenceEvent } from '@concord/shared';
import { PresenceStore } from '../src/presence-store';
import type { ResolvedProfile } from '../src/profiles';

// avatarUrl: null is what presence reports when no profile is known, camera/music: false while
// no camera/music track is published.
const off = { avatarUrl: null, camera: false, music: false };
const alice = { id: 'alice', name: 'Alice', joinedAt: 1_000, ...off };
const bob = { id: 'bob', name: 'Bob', joinedAt: 2_000, ...off };
const carol = { id: 'carol', name: 'Carol', joinedAt: 3_000, ...off };

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
    store.cameraTrackUnpublished('geral', 'ghost', 'TR_1');
    store.cameraTrackUnpublished('nowhere', 'ghost', 'TR_1');
    store.musicTrackUnpublished('geral', 'ghost', 'TR_1');
    store.musicTrackUnpublished('nowhere', 'ghost', 'TR_1');
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

  describe('cameras', () => {
    it('announces camera with participant_updated only when it flips', () => {
      store.join('geral', alice);
      store.cameraTrackPublished('geral', alice, 'TR_cam1');
      store.cameraTrackPublished('geral', alice, 'TR_cam1'); // duplicate webhook
      store.cameraTrackPublished('geral', alice, 'TR_cam2'); // a second camera
      store.cameraTrackUnpublished('geral', 'alice', 'TR_cam1');
      store.cameraTrackUnpublished('geral', 'alice', 'TR_unknown');
      expect(events.slice(1)).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, camera: true },
        },
      ]);
      expect(store.participant('geral', 'alice')?.camera).toBe(true);

      store.cameraTrackUnpublished('geral', 'alice', 'TR_cam2');
      store.cameraTrackUnpublished('geral', 'alice', 'TR_cam2'); // duplicate webhook
      expect(events.slice(2)).toEqual([
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
      expect(store.participant('geral', 'alice')?.camera).toBe(false);
    });

    it('never counts a camera as streaming nor a screen as a camera', () => {
      store.join('geral', alice);
      store.screenTrackPublished('geral', alice, 'TR_screen');
      store.cameraTrackPublished('geral', alice, 'TR_cam');
      store.screenTrackUnpublished('geral', 'alice', 'TR_screen');
      store.cameraTrackUnpublished('geral', 'alice', 'TR_cam');
      expect(events.slice(1)).toEqual([
        { type: 'stream_started', room: 'geral', participantId: 'alice' },
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: true, camera: true },
        },
        { type: 'stream_stopped', room: 'geral', participantId: 'alice' },
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
    });

    it('unpublishing a camera track SID never touches the screen tracks', () => {
      store.screenTrackPublished('geral', alice, 'TR_1');
      events.length = 0;
      store.cameraTrackUnpublished('geral', 'alice', 'TR_1');
      expect(events).toEqual([]);
      expect(store.participant('geral', 'alice')?.streaming).toBe(true);
    });

    it('creates the participant when a camera track arrives before the join', () => {
      store.cameraTrackPublished('jogos', bob, 'TR_cam');
      expect(events).toEqual([
        { type: 'participant_joined', room: 'jogos', participant: { ...bob, streaming: false } },
        {
          type: 'participant_updated',
          room: 'jogos',
          participant: { ...bob, streaming: false, camera: true },
        },
      ]);
    });

    it('a participant with a camera leaves with a single participant_left', () => {
      store.join('geral', alice);
      store.cameraTrackPublished('geral', alice, 'TR_cam');
      events.length = 0;
      store.leave('geral', 'alice');
      expect(events).toEqual([
        {
          type: 'participant_left',
          room: 'geral',
          participant: { ...alice, streaming: false, camera: true },
        },
      ]);

      store.join('geral', alice);
      expect(store.participant('geral', 'alice')?.camera).toBe(false);
    });

    it('shows the camera flag in snapshots', () => {
      store.join('geral', alice);
      store.cameraTrackPublished('geral', bob, 'TR_cam');
      expect(store.snapshot().rooms.geral).toEqual([
        { ...alice, streaming: false },
        { ...bob, streaming: false, camera: true },
      ]);
    });
  });

  describe('music', () => {
    it('announces music with participant_updated only when it flips', () => {
      store.join('geral', alice);
      store.musicTrackPublished('geral', alice, 'TR_music1');
      store.musicTrackPublished('geral', alice, 'TR_music1'); // duplicate webhook
      store.musicTrackPublished('geral', alice, 'TR_music2'); // a second app
      store.musicTrackUnpublished('geral', 'alice', 'TR_music1');
      store.musicTrackUnpublished('geral', 'alice', 'TR_unknown');
      expect(events.slice(1)).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, music: true },
        },
      ]);
      expect(store.participant('geral', 'alice')?.music).toBe(true);

      store.musicTrackUnpublished('geral', 'alice', 'TR_music2');
      store.musicTrackUnpublished('geral', 'alice', 'TR_music2'); // duplicate webhook
      expect(events.slice(2)).toEqual([
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
      expect(store.participant('geral', 'alice')?.music).toBe(false);
    });

    it('never counts music as streaming nor as a camera', () => {
      store.join('geral', alice);
      store.screenTrackPublished('geral', alice, 'TR_screen');
      store.musicTrackPublished('geral', alice, 'TR_music');
      store.cameraTrackPublished('geral', alice, 'TR_cam');
      store.screenTrackUnpublished('geral', 'alice', 'TR_screen');
      store.musicTrackUnpublished('geral', 'alice', 'TR_music');
      store.cameraTrackUnpublished('geral', 'alice', 'TR_cam');
      expect(events.slice(1)).toEqual([
        { type: 'stream_started', room: 'geral', participantId: 'alice' },
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: true, music: true },
        },
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: true, camera: true, music: true },
        },
        { type: 'stream_stopped', room: 'geral', participantId: 'alice' },
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, camera: true },
        },
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
    });

    it('unpublishing a music track SID never touches the screen or camera tracks', () => {
      store.screenTrackPublished('geral', alice, 'TR_1');
      store.cameraTrackPublished('geral', alice, 'TR_2');
      events.length = 0;
      store.musicTrackUnpublished('geral', 'alice', 'TR_1');
      store.musicTrackUnpublished('geral', 'alice', 'TR_2');
      expect(events).toEqual([]);
      expect(store.participant('geral', 'alice')).toEqual({
        ...alice,
        streaming: true,
        camera: true,
      });
    });

    it('creates the participant when a music track arrives before the join', () => {
      store.musicTrackPublished('jogos', bob, 'TR_music');
      expect(events).toEqual([
        { type: 'participant_joined', room: 'jogos', participant: { ...bob, streaming: false } },
        {
          type: 'participant_updated',
          room: 'jogos',
          participant: { ...bob, streaming: false, music: true },
        },
      ]);
    });

    it('a participant broadcasting music leaves with a single participant_left', () => {
      store.join('geral', alice);
      store.musicTrackPublished('geral', alice, 'TR_music');
      events.length = 0;
      store.leave('geral', 'alice');
      expect(events).toEqual([
        {
          type: 'participant_left',
          room: 'geral',
          participant: { ...alice, streaming: false, music: true },
        },
      ]);

      store.join('geral', alice);
      expect(store.participant('geral', 'alice')?.music).toBe(false);
    });

    it('shows the music flag in snapshots', () => {
      store.join('geral', alice);
      store.musicTrackPublished('geral', bob, 'TR_music');
      expect(store.snapshot().rooms.geral).toEqual([
        { ...alice, streaming: false },
        { ...bob, streaming: false, music: true },
      ]);
    });
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
      resolved.cameraTrackPublished('geral', alice, 'TR_cam');
      resolved.screenTrackPublished('jogos', alice, 'TR_1');
      resolved.join('geral', bob);
      events.length = 0;

      profiles.set('alice', { name: 'Lice', avatarUrl: 'https://a/2.png' });
      resolved.refreshUser('alice');
      const lice = { ...alice, name: 'Lice', avatarUrl: 'https://a/2.png' };
      expect(events).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...lice, streaming: false, camera: true },
        },
        { type: 'participant_updated', room: 'jogos', participant: { ...lice, streaming: true } },
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

      const dave = { id: 'dave', name: 'Dave', joinedAt: 4_000, ...off };
      store.replaceAll({
        geral: [
          { ...alice, screenTracks: ['TR_1'], cameraTracks: [], musicTracks: [] },
          { ...dave, screenTracks: ['TR_4'], cameraTracks: [], musicTracks: [] },
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
        geral: [
          { ...alice, screenTracks: ['TR_1'], cameraTracks: ['TR_cam'], musicTracks: ['TR_m'] },
        ],
        jogos: [{ ...bob, screenTracks: [], cameraTracks: [], musicTracks: [] }],
      };
      store.replaceAll(state);
      events.length = 0;
      store.replaceAll(state);
      expect(events).toEqual([]);
    });

    it('stops streams whose tracks disappeared', () => {
      store.replaceAll({
        geral: [{ ...alice, screenTracks: ['TR_1'], cameraTracks: [], musicTracks: [] }],
      });
      events.length = 0;
      store.replaceAll({
        geral: [{ ...alice, screenTracks: [], cameraTracks: [], musicTracks: [] }],
      });
      expect(events).toEqual([{ type: 'stream_stopped', room: 'geral', participantId: 'alice' }]);
    });

    it('announces cameras that appeared or disappeared with participant_updated', () => {
      store.join('geral', alice);
      store.cameraTrackPublished('geral', bob, 'TR_cam_b');
      events.length = 0;

      store.replaceAll({
        geral: [
          { ...alice, screenTracks: [], cameraTracks: ['TR_cam_a'], musicTracks: [] },
          { ...bob, screenTracks: [], cameraTracks: [], musicTracks: [] },
        ],
      });
      expect(events).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, camera: true },
        },
        { type: 'participant_updated', room: 'geral', participant: { ...bob, streaming: false } },
      ]);
    });

    it('a participant who joins with a camera never starts a stream', () => {
      store.replaceAll({
        geral: [{ ...alice, screenTracks: [], cameraTracks: ['TR_cam'], musicTracks: [] }],
      });
      expect(events).toEqual([
        { type: 'participant_joined', room: 'geral', participant: { ...alice, streaming: false } },
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, camera: true },
        },
      ]);
    });

    it('adopts the server camera track SIDs without announcing an unchanged flag', () => {
      store.cameraTrackPublished('geral', alice, 'TR_old');
      events.length = 0;

      store.replaceAll({
        geral: [{ ...alice, screenTracks: [], cameraTracks: ['TR_new'], musicTracks: [] }],
      });
      expect(events).toEqual([]);

      // The stale track is gone: its late unpublish changes nothing, the current one does.
      store.cameraTrackUnpublished('geral', 'alice', 'TR_old');
      expect(events).toEqual([]);
      store.cameraTrackUnpublished('geral', 'alice', 'TR_new');
      expect(events).toEqual([
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
    });

    it('announces music that appeared or disappeared with participant_updated', () => {
      store.join('geral', alice);
      store.musicTrackPublished('geral', bob, 'TR_music_b');
      events.length = 0;

      store.replaceAll({
        geral: [
          { ...alice, screenTracks: [], cameraTracks: [], musicTracks: ['TR_music_a'] },
          { ...bob, screenTracks: [], cameraTracks: [], musicTracks: [] },
        ],
      });
      expect(events).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, music: true },
        },
        { type: 'participant_updated', room: 'geral', participant: { ...bob, streaming: false } },
      ]);
    });

    it('announces a camera and music flipping together with one participant_updated', () => {
      store.join('geral', alice);
      events.length = 0;

      store.replaceAll({
        geral: [{ ...alice, screenTracks: [], cameraTracks: ['TR_cam'], musicTracks: ['TR_m'] }],
      });
      expect(events).toEqual([
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, camera: true, music: true },
        },
      ]);
    });

    it('a participant who joins with music never starts a stream', () => {
      store.replaceAll({
        geral: [{ ...alice, screenTracks: [], cameraTracks: [], musicTracks: ['TR_music'] }],
      });
      expect(events).toEqual([
        { type: 'participant_joined', room: 'geral', participant: { ...alice, streaming: false } },
        {
          type: 'participant_updated',
          room: 'geral',
          participant: { ...alice, streaming: false, music: true },
        },
      ]);
    });

    it('adopts the server music track SIDs without announcing an unchanged flag', () => {
      store.musicTrackPublished('geral', alice, 'TR_old');
      events.length = 0;

      store.replaceAll({
        geral: [{ ...alice, screenTracks: [], cameraTracks: [], musicTracks: ['TR_new'] }],
      });
      expect(events).toEqual([]);

      // The stale track is gone: its late unpublish changes nothing, the current one does.
      store.musicTrackUnpublished('geral', 'alice', 'TR_old');
      expect(events).toEqual([]);
      store.musicTrackUnpublished('geral', 'alice', 'TR_new');
      expect(events).toEqual([
        { type: 'participant_updated', room: 'geral', participant: { ...alice, streaming: false } },
      ]);
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
