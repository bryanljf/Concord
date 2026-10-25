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
  isJamBotIdentity,
  JAM_BOT_IDENTITY,
  JAM_BOT_NAME,
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

/**
 * The regular participant: publishes screen-share video/audio and a webcam, and sets its own
 * attributes (the lives it watches, so the others can list their viewers). It never publishes a
 * microphone: voice stays on Discord, and only the jam bot publishes under the Microphone source.
 */
const MAIN_GRANT: Omit<VideoGrant, 'room'> = {
  roomJoin: true,
  canSubscribe: true,
  canPublish: true,
  canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.CAMERA],
  canPublishData: true,
  canUpdateOwnMetadata: true,
};

/**
 * The pop-out and picture-in-picture windows: extra, hidden, subscribe-only connections of the
 * same person.
 */
const POPOUT_GRANT: Omit<VideoGrant, 'room'> = {
  roomJoin: true,
  canSubscribe: true,
  canPublish: false,
  canPublishData: false,
  hidden: true,
};

/**
 * Issues a join token for `room`. `main` (default) joins as `user.id` with screen-share and
 * camera publish grants; `popout` / `pip` join as the auxiliary identity `<id>~<purpose>`,
 * hidden and subscribe-only.
 * `name` is the display name LiveKit shows (the resolved profile name; defaults to users.json).
 */
export async function createRoomToken(
  livekit: LiveKitConfig,
  user: User,
  room: RoomId,
  purpose: TokenPurpose = 'main',
  name: string = user.displayName,
): Promise<RoomToken> {
  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: purpose === 'main' ? user.id : auxiliaryIdentity(user.id, purpose),
    name,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({ ...(purpose === 'main' ? MAIN_GRANT : POPOUT_GRANT), room });
  // The SDK derives `exp` from the wall clock inside toJwt(); mirror it at second precision.
  const expiresAt = (Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS) * 1000;
  return { token: await token.toJwt(), expiresAt };
}

/**
 * The jam bot: publishes the room's jam as one audio track (Microphone source, named
 * `concord:music:jam`) and nothing else; it never subscribes, sends data or edits its metadata.
 */
const JAM_BOT_GRANT: Omit<VideoGrant, 'room'> = {
  roomJoin: true,
  canSubscribe: false,
  canPublish: true,
  canPublishSources: [TrackSource.MICROPHONE],
  canPublishData: false,
  canUpdateOwnMetadata: false,
};

/** Issues the jam bot's join token for `room` (identity `@jam`, name `Jam`). */
export async function createJamBotToken(livekit: LiveKitConfig, room: RoomId): Promise<RoomToken> {
  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: JAM_BOT_IDENTITY,
    name: JAM_BOT_NAME,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({ ...JAM_BOT_GRANT, room });
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

export function isCameraVideo(track: Pick<TrackInfo, 'source' | 'type'>): boolean {
  return track.source === TrackSource.CAMERA && track.type === TrackType.VIDEO;
}

/** Auxiliary identities (pop-out/PiP windows) are extra connections of a person, not presence. */
export function isAuxiliaryParticipant(participant: Pick<ParticipantInfo, 'identity'>): boolean {
  return isAuxiliaryIdentity(participant.identity);
}

/** The jam bot is not a person: it never shows up in presence. */
export function isJamBotParticipant(participant: Pick<ParticipantInfo, 'identity'>): boolean {
  return isJamBotIdentity(participant.identity);
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
    cameraTracks: participant.tracks.filter(isCameraVideo).map((track) => track.sid),
  };
}

/**
 * Reads the authoritative room/participant state from the LiveKit server, leaving auxiliary
 * identities and the jam bot out so a resync never surfaces them in presence.
 */
export async function fetchRoomState(roomService: RoomServiceLike): Promise<RoomState> {
  const rooms = await roomService.listRooms();
  const entries = await Promise.all(
    rooms.map(async (room) => {
      const participants = await roomService.listParticipants(room.name);
      const members = participants.filter(
        (participant) => !isAuxiliaryParticipant(participant) && !isJamBotParticipant(participant),
      );
      return [room.name, members.map(toParticipantState)] as const;
    }),
  );
  return Object.fromEntries(entries);
}
