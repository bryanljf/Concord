import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
  WebhookReceiver,
  type ParticipantInfo,
  type TrackInfo,
} from 'livekit-server-sdk';
import { TOKEN_TTL_SECONDS, type RoomId } from '@concord/shared';
import type { User } from './auth';
import type { LiveKitConfig } from './config';
import type { ParticipantIdentity, ParticipantState, RoomState } from './presence-store';

export interface RoomToken {
  token: string;
  /** Unix epoch in milliseconds. */
  expiresAt: number;
}

/** Issues a join token that can only publish screen-share video/audio (no camera or mic). */
export async function createRoomToken(
  livekit: LiveKitConfig,
  user: User,
  room: RoomId,
): Promise<RoomToken> {
  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: user.id,
    name: user.displayName,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canPublishData: true,
  });
  // The SDK derives `exp` from the wall clock inside toJwt(); mirror it at second precision.
  const expiresAt = (Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS) * 1000;
  return { token: await token.toJwt(), expiresAt };
}

export function createWebhookReceiver(livekit: LiveKitConfig): WebhookReceiver {
  return new WebhookReceiver(livekit.apiKey, livekit.apiSecret);
}

export function createRoomService(livekit: LiveKitConfig): RoomServiceClient {
  return new RoomServiceClient(livekit.apiUrl, livekit.apiKey, livekit.apiSecret);
}

/** The subset of RoomServiceClient the api depends on (easy to fake in tests). */
export type RoomServiceLike = Pick<RoomServiceClient, 'listRooms' | 'listParticipants'>;

export function isScreenShareVideo(track: Pick<TrackInfo, 'source' | 'type'>): boolean {
  return track.source === TrackSource.SCREEN_SHARE && track.type === TrackType.VIDEO;
}

export function toParticipantIdentity(participant: ParticipantInfo): ParticipantIdentity {
  return {
    id: participant.identity,
    name: participant.name || participant.identity,
    joinedAt: Number(participant.joinedAt) * 1000,
  };
}

function toParticipantState(participant: ParticipantInfo): ParticipantState {
  return {
    ...toParticipantIdentity(participant),
    screenTracks: participant.tracks.filter(isScreenShareVideo).map((track) => track.sid),
  };
}

/** Reads the authoritative room/participant state from the LiveKit server. */
export async function fetchRoomState(roomService: RoomServiceLike): Promise<RoomState> {
  const rooms = await roomService.listRooms();
  const entries = await Promise.all(
    rooms.map(async (room) => {
      const participants = await roomService.listParticipants(room.name);
      return [room.name, participants.map(toParticipantState)] as const;
    }),
  );
  return Object.fromEntries(entries);
}
