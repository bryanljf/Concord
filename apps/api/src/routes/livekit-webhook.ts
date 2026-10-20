import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebhookEvent, WebhookReceiver } from 'livekit-server-sdk';
import type { ApiErrorResponse, HealthResponse } from '@concord/shared';
import {
  isAuxiliaryParticipant,
  isCameraVideo,
  isScreenShareVideo,
  toParticipantIdentity,
} from '../livekit';
import type { Logger } from '../logger';
import type { PresenceStore } from '../presence-store';

export interface LivekitWebhookRoutesOptions {
  receiver: Pick<WebhookReceiver, 'receive'>;
  presence: PresenceStore;
}

/**
 * Applies one verified LiveKit webhook event to the presence store. Events about auxiliary
 * identities (pop-out and PiP windows) are dropped: the person is already represented by their
 * main connection.
 */
export function applyWebhookEvent(presence: PresenceStore, event: WebhookEvent, log: Logger): void {
  const room = event.room?.name;
  const { participant, track } = event;
  if (!room) {
    log.debug({ event: event.event }, 'ignoring LiveKit webhook without a room');
    return;
  }
  if (participant && isAuxiliaryParticipant(participant)) {
    log.debug(
      { event: event.event, room, identity: participant.identity },
      'ignoring LiveKit webhook for an auxiliary identity',
    );
    return;
  }
  switch (event.event) {
    case 'participant_joined':
      if (participant) presence.join(room, toParticipantIdentity(participant));
      break;
    case 'participant_left':
      if (participant) presence.leave(room, participant.identity);
      break;
    case 'track_published':
      if (participant && track && isScreenShareVideo(track)) {
        presence.screenTrackPublished(room, toParticipantIdentity(participant), track.sid);
      } else if (participant && track && isCameraVideo(track)) {
        presence.cameraTrackPublished(room, toParticipantIdentity(participant), track.sid);
      }
      break;
    case 'track_unpublished':
      if (participant && track && isScreenShareVideo(track)) {
        presence.screenTrackUnpublished(room, participant.identity, track.sid);
      } else if (participant && track && isCameraVideo(track)) {
        presence.cameraTrackUnpublished(room, participant.identity, track.sid);
      }
      break;
    case 'room_finished':
      presence.clearRoom(room);
      break;
    default:
      log.debug({ event: event.event, room }, 'ignoring LiveKit webhook event');
  }
}

function keepRawBody(
  _request: FastifyRequest,
  body: string,
  done: (err: Error | null, body?: unknown) => void,
): void {
  done(null, body);
}

/**
 * `POST /api/livekit/webhook`: receives events pushed by livekit-server. The signature covers
 * the exact bytes sent, so this plugin keeps the body as a raw string. Content-type parsers are
 * scoped to this plugin, so the rest of the app keeps Fastify's regular JSON parsing.
 */
export const livekitWebhookRoutes: FastifyPluginAsync<LivekitWebhookRoutesOptions> = async (
  app,
  { receiver, presence },
) => {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, keepRawBody);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, keepRawBody);

  app.post<{ Body: string | undefined }>(
    '/api/livekit/webhook',
    async (request, reply): Promise<HealthResponse | ApiErrorResponse> => {
      let event: WebhookEvent;
      try {
        event = await receiver.receive(request.body ?? '', request.headers.authorization);
      } catch (err) {
        request.log.warn({ err }, 'rejected LiveKit webhook');
        reply.code(401);
        return { error: 'invalid_webhook', message: 'Assinatura do webhook inválida.' };
      }
      applyWebhookEvent(presence, event, request.log);
      return { ok: true };
    },
  );
};
