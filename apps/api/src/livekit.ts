import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
  WebhookReceiver,
  type ParticipantInfo,
  type TrackInfo,
  type VideoGrant,
} from 'livekit-server-sdk';
import {
  auxiliaryIdentity,
  isAuxiliaryIdentity,
  TOKEN_TTL_SECONDS,
  type RoomId,
  type TokenPurpose,
} from '@concord/shared';
import type { User } from './auth';
import type { LiveKitConfig } from './config';
import type { ParticipantIdentity, ParticipantState, RoomState } from './presence-store';

export interface RoomToken {
  token: string;
  /** Unix epoch in milliseconds. */
  expiresAt: number;
}

/** The regular participant: publishes screen-share video/audio only (no camera or mic). */
const MAIN_GRANT: Omit<VideoGrant, 'room'> = {
  roomJoin: true,
  canSubscribe: true,
  canPublish: true,
  canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  canPublishData: true,
};

/** The pop-out window: a second, hidden, subscribe-only connection of the same person. */
const POPOUT_GRANT: Omit<VideoGrant, 'room'> = {
  roomJoin: true,
  canSubscribe: true,
  canPublish: false,
  canPublishData: false,
  hidden: true,
};

/**
 * Issues a join token for `room`. `main` (default) joins as `user.id` with screen-share publish
 * grants; `popout` joins as the auxiliary identity `<id>~popout`, hidden and subscribe-only.
 */
export async function createRoomToken(
  livekit: LiveKitConfig,
  user: User,
  room: RoomId,
  purpose: TokenPurpose = 'main',
): Promise<RoomToken> {
  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: purpose === 'main' ? user.id : auxiliaryIdentity(user.id, purpose),
    name: user.displayName,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({ ...(purpose === 'main' ? MAIN_GRANT : POPOUT_GRANT), room });
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

/** Auxiliary identities (pop-out windows) are extra connections of a person, not presence. */
export function isAuxiliaryParticipant(participant: Pick<ParticipantInfo, 'identity'>): boolean {
  return isAuxiliaryIdentity(participant.identity);
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

/**
 * Reads the authoritative room/participant state from the LiveKit server, leaving auxiliary
 * identities out so a resync never surfaces them in presence.
 */
export async function fetchRoomState(roomService: RoomServiceLike): Promise<RoomState> {
  const rooms = await roomService.listRooms();
  const entries = await Promise.all(
    rooms.map(async (room) => {
      const participants = await roomService.listParticipants(room.name);
      const members = participants.filter((participant) => !isAuxiliaryParticipant(participant));
      return [room.name, members.map(toParticipantState)] as const;
    }),
  );
  return Object.fromEntries(entries);
}
