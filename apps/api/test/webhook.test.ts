import type { FastifyInstance } from 'fastify';
import { WebhookEvent } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import type { ApiErrorResponse, PresenceEvent } from '@concord/shared';
import { PresenceStore } from '../src/presence-store';
import { applyWebhookEvent } from '../src/routes/livekit-webhook';
import { fakeLogger, signWebhook, testApp } from './helpers';

const room = { sid: 'RM_1', name: 'geral' };
const alice = { sid: 'PA_1', identity: 'alice', name: 'Alice', joinedAt: '1700000000' };
const bob = { sid: 'PA_2', identity: 'bob', name: '', joinedAt: '1700000010' };
const screenTrack = { sid: 'TR_1', type: 'VIDEO', source: 'SCREEN_SHARE' };
const cameraTrack = { sid: 'TR_2', type: 'VIDEO', source: 'CAMERA' };
const screenAudioTrack = { sid: 'TR_3', type: 'AUDIO', source: 'SCREEN_SHARE_AUDIO' };
// An app's music goes out under the Microphone source (never a real microphone).
const musicTrack = {
  sid: 'TR_4',
  type: 'AUDIO',
  source: 'MICROPHONE',
  name: 'concord:music:spotify',
};
// A Microphone track that is not Concord's music.
const foreignMicrophoneTrack = { sid: 'TR_5', type: 'AUDIO', source: 'MICROPHONE', name: 'mic' };

const alicePresence = {
  id: 'alice',
  name: 'Alice',
  streaming: false,
  joinedAt: 1_700_000_000_000,
  avatarUrl: null,
  camera: false,
  music: false,
};
// LiveKit sent no name for bob: presence resolves it from users.json ("Bob").
const bobPresence = {
  id: 'bob',
  name: 'Bob',
  streaming: false,
  joinedAt: 1_700_000_010_000,
  avatarUrl: null,
  camera: false,
  music: false,
};

interface PostOptions {
  secret?: string;
  contentType?: string;
  /** Sign this body instead of the one actually sent (simulates tampering in transit). */
  signedBody?: string;
  unsigned?: boolean;
}

async function postWebhook(app: FastifyInstance, event: object, options: PostOptions = {}) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/webhook+json',
  };
  if (!options.unsigned) {
    headers.authorization = await signWebhook(options.signedBody ?? body, options.secret);
  }
  return app.inject({ method: 'POST', url: '/api/livekit/webhook', headers, payload: body });
}

describe('POST /api/livekit/webhook', () => {
  it('feeds the presence store from a signed event sequence', async () => {
    const { app, presence } = testApp();
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));

    const sequence = [
      { event: 'participant_joined', room, participant: alice },
      { event: 'track_published', room, participant: alice, track: screenAudioTrack },
      { event: 'track_published', room, participant: alice, track: screenTrack },
      { event: 'track_unpublished', room, participant: alice, track: screenTrack },
      { event: 'participant_left', room, participant: alice },
      { event: 'participant_joined', room, participant: bob },
      { event: 'room_finished', room },
    ];
    for (const event of sequence) {
      const res = await postWebhook(app, event);
      expect(res.statusCode, event.event).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }

    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: alicePresence },
      { type: 'stream_started', room: 'geral', participantId: 'alice' },
      { type: 'stream_stopped', room: 'geral', participantId: 'alice' },
      { type: 'participant_left', room: 'geral', participant: alicePresence },
      { type: 'participant_joined', room: 'geral', participant: bobPresence },
      { type: 'participant_left', room: 'geral', participant: bobPresence },
    ]);
    expect(presence.snapshot().rooms.geral).toEqual([]);
    await app.close();
  });

  it('announces a camera with participant_updated, never as a stream', async () => {
    const { app, presence } = testApp();
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));

    const sequence = [
      { event: 'participant_joined', room, participant: alice },
      { event: 'track_published', room, participant: alice, track: cameraTrack },
      { event: 'track_published', room, participant: alice, track: cameraTrack },
      { event: 'track_published', room, participant: alice, track: screenAudioTrack },
      { event: 'track_unpublished', room, participant: alice, track: screenAudioTrack },
      { event: 'track_unpublished', room, participant: alice, track: cameraTrack },
      { event: 'track_unpublished', room, participant: alice, track: cameraTrack },
    ];
    for (const event of sequence) {
      const res = await postWebhook(app, event);
      expect(res.statusCode, event.event).toBe(200);
    }

    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: alicePresence },
      {
        type: 'participant_updated',
        room: 'geral',
        participant: { ...alicePresence, camera: true },
      },
      { type: 'participant_updated', room: 'geral', participant: alicePresence },
    ]);
    expect(presence.snapshot().rooms.geral).toEqual([alicePresence]);
    await app.close();
  });

  it('creates the participant when a camera track is published before the join event', async () => {
    const { app, presence } = testApp();
    const res = await postWebhook(app, {
      event: 'track_published',
      room,
      participant: bob,
      track: cameraTrack,
    });
    expect(res.statusCode).toBe(200);
    expect(presence.snapshot().rooms.geral).toEqual([{ ...bobPresence, camera: true }]);
    await app.close();
  });

  it('announces music with participant_updated, never as a stream', async () => {
    const { app, presence } = testApp();
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));

    const sequence = [
      { event: 'participant_joined', room, participant: alice },
      { event: 'track_published', room, participant: alice, track: musicTrack },
      { event: 'track_published', room, participant: alice, track: musicTrack },
      { event: 'track_published', room, participant: alice, track: foreignMicrophoneTrack },
      { event: 'track_unpublished', room, participant: alice, track: foreignMicrophoneTrack },
      { event: 'track_unpublished', room, participant: alice, track: musicTrack },
      { event: 'track_unpublished', room, participant: alice, track: musicTrack },
    ];
    for (const event of sequence) {
      const res = await postWebhook(app, event);
      expect(res.statusCode, event.event).toBe(200);
    }

    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: alicePresence },
      {
        type: 'participant_updated',
        room: 'geral',
        participant: { ...alicePresence, music: true },
      },
      { type: 'participant_updated', room: 'geral', participant: alicePresence },
    ]);
    expect(presence.snapshot().rooms.geral).toEqual([alicePresence]);
    await app.close();
  });

  it('keeps music apart from the screen share and its audio', async () => {
    const { app, presence } = testApp();
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));
    const sequence = [
      { event: 'track_published', room, participant: alice, track: screenTrack },
      { event: 'track_published', room, participant: alice, track: screenAudioTrack },
      { event: 'track_published', room, participant: alice, track: musicTrack },
      { event: 'track_unpublished', room, participant: alice, track: screenTrack },
      { event: 'track_unpublished', room, participant: alice, track: screenAudioTrack },
    ];
    for (const event of sequence) {
      const res = await postWebhook(app, event);
      expect(res.statusCode, event.event).toBe(200);
    }
    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: alicePresence },
      { type: 'stream_started', room: 'geral', participantId: 'alice' },
      {
        type: 'participant_updated',
        room: 'geral',
        participant: { ...alicePresence, streaming: true, music: true },
      },
      { type: 'stream_stopped', room: 'geral', participantId: 'alice' },
    ]);
    expect(presence.snapshot().rooms.geral).toEqual([{ ...alicePresence, music: true }]);
    await app.close();
  });

  it('creates the participant when a music track is published before the join event', async () => {
    const { app, presence } = testApp();
    const res = await postWebhook(app, {
      event: 'track_published',
      room,
      participant: bob,
      track: musicTrack,
    });
    expect(res.statusCode).toBe(200);
    expect(presence.snapshot().rooms.geral).toEqual([{ ...bobPresence, music: true }]);
    await app.close();
  });

  it.each(['ana~popout', 'ana~pip'])(
    'ignores every event about an auxiliary identity (%s)',
    async (identity) => {
      const { app, presence } = testApp();
      const events: PresenceEvent[] = [];
      presence.subscribe((event) => events.push(event));
      const auxiliary = { sid: 'PA_3', identity, name: 'Ana', joinedAt: '1700000020' };

      const sequence = [
        { event: 'participant_joined', room, participant: auxiliary },
        { event: 'track_published', room, participant: auxiliary, track: screenTrack },
        { event: 'track_published', room, participant: auxiliary, track: cameraTrack },
        { event: 'track_published', room, participant: auxiliary, track: musicTrack },
        { event: 'track_unpublished', room, participant: auxiliary, track: musicTrack },
        { event: 'track_unpublished', room, participant: auxiliary, track: cameraTrack },
        { event: 'track_unpublished', room, participant: auxiliary, track: screenTrack },
        { event: 'participant_left', room, participant: auxiliary },
      ];
      for (const event of sequence) {
        const res = await postWebhook(app, event);
        expect(res.statusCode, event.event).toBe(200);
        expect(res.json()).toEqual({ ok: true });
      }

      expect(events).toEqual([]);
      expect(presence.snapshot()).toEqual({ rooms: { geral: [], jogos: [] } });
      await app.close();
    },
  );

  it('creates the participant when a screen track is published before the join event', async () => {
    const { app, presence } = testApp();
    const res = await postWebhook(app, {
      event: 'track_published',
      room,
      participant: bob,
      track: screenTrack,
    });
    expect(res.statusCode).toBe(200);
    expect(presence.snapshot().rooms.geral).toEqual([{ ...bobPresence, streaming: true }]);
    await app.close();
  });

  it('also accepts application/json', async () => {
    const { app, presence } = testApp();
    const res = await postWebhook(
      app,
      { event: 'participant_joined', room, participant: alice },
      { contentType: 'application/json' },
    );
    expect(res.statusCode).toBe(200);
    expect(presence.snapshot().rooms.geral).toEqual([alicePresence]);
    await app.close();
  });

  it.each<[string, PostOptions]>([
    ['a wrong secret', { secret: 'x'.repeat(32) }],
    [
      'a tampered body',
      { signedBody: JSON.stringify({ event: 'participant_left', room, participant: alice }) },
    ],
    ['no signature', { unsigned: true }],
  ])('rejects %s with 401 and leaves the store untouched', async (_label, options) => {
    const { app, presence } = testApp();
    const res = await postWebhook(
      app,
      { event: 'participant_joined', room, participant: alice },
      options,
    );
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_webhook');
    expect(presence.snapshot().rooms.geral).toEqual([]);
    await app.close();
  });
});

describe('applyWebhookEvent', () => {
  it('ignores unrelated events and events without a room, logging them at debug level', () => {
    const presence = new PresenceStore(['geral']);
    const log = fakeLogger();
    applyWebhookEvent(presence, WebhookEvent.fromJson({ event: 'egress_started', room }), log);
    applyWebhookEvent(
      presence,
      WebhookEvent.fromJson({ event: 'participant_joined', participant: alice }),
      log,
    );
    expect(log.debug).toHaveBeenCalledTimes(2);
    expect(presence.snapshot()).toEqual({ rooms: { geral: [] } });
  });

  it('drops auxiliary identities at debug level but still closes the room', () => {
    const presence = new PresenceStore(['geral']);
    const log = fakeLogger();
    presence.join('geral', { id: 'alice', name: 'Alice', joinedAt: 1 });
    const popout = { ...alice, identity: 'alice~popout' };
    applyWebhookEvent(
      presence,
      WebhookEvent.fromJson({ event: 'participant_joined', room, participant: popout }),
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ identity: 'alice~popout', room: 'geral' }),
      expect.any(String),
    );
    expect(presence.snapshot().rooms.geral).toHaveLength(1);

    applyWebhookEvent(presence, WebhookEvent.fromJson({ event: 'room_finished', room }), log);
    expect(presence.snapshot()).toEqual({ rooms: { geral: [] } });
  });
});
