import { useEffect, useState } from 'react';
import { isAuxiliaryIdentity, isJamBotIdentity } from '@concord/shared';
import {
  RoomEvent,
  Track,
  type ConnectionQuality,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type Room,
} from 'livekit-client';
import { streamKey, type StreamKind } from '../lib/streamKey';

/**
 * One remote video (a screen share or a webcam), as seen by livekit (the source of truth on
 * stage). A participant with both appears twice, with different `key`s.
 */
export interface RemoteStream {
  /** `participantId` for the screen share, `participantId#camera` for the webcam. */
  key: string;
  kind: StreamKind;
  /** Participant identity (= user id from concord-api). */
  participantId: string;
  /** LiveKit name; Workspace/PopoutView replace it with the presence name when known. */
  name: string;
  /** Discord avatar from presence (LiveKit does not carry it); null until merged. */
  avatarUrl: string | null;
  participant: RemoteParticipant;
  video: RemoteTrackPublication | null;
  /** Screen-share audio; always null for a webcam (voice stays on Discord). */
  audio: RemoteTrackPublication | null;
  /** Set once the publication is subscribed and the track arrived. */
  videoTrack: RemoteVideoTrack | null;
  audioTrack: RemoteAudioTrack | null;
  quality: ConnectionQuality;
  /** `Paused` when the server stopped forwarding video (no bandwidth / nobody watching). */
  streamState: Track.StreamState;
  /** The publisher muted the video (e.g. minimized window on some platforms). */
  videoMuted: boolean;
}

function videoTrackOf(publication: RemoteTrackPublication | null): RemoteVideoTrack | null {
  const track = publication?.track;
  return track && track.kind === Track.Kind.Video ? (track as RemoteVideoTrack) : null;
}

function audioTrackOf(publication: RemoteTrackPublication | null): RemoteAudioTrack | null {
  const track = publication?.track;
  return track && track.kind === Track.Kind.Audio ? (track as RemoteAudioTrack) : null;
}

function publicationOf(
  participant: RemoteParticipant,
  source: Track.Source,
  kind: Track.Kind,
): RemoteTrackPublication | null {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source === source && publication.kind === kind) return publication;
  }
  return null;
}

function toStream(
  participant: RemoteParticipant,
  kind: StreamKind,
  video: RemoteTrackPublication,
  audio: RemoteTrackPublication | null,
): RemoteStream {
  const videoTrack = videoTrackOf(video);
  return {
    key: streamKey(participant.identity, kind),
    kind,
    participantId: participant.identity,
    name: participant.name || participant.identity,
    avatarUrl: null,
    participant,
    video,
    audio,
    videoTrack,
    audioTrack: audioTrackOf(audio),
    quality: participant.connectionQuality,
    streamState: videoTrack?.streamState ?? Track.StreamState.Unknown,
    videoMuted: video.isMuted,
  };
}

/**
 * Snapshot of every visible participant's screen share and webcam, sorted by join time (a
 * participant's screen share before their webcam).
 */
export function collectRemoteStreams(room: Room): RemoteStream[] {
  const participants = [...room.remoteParticipants.values()]
    // The jam bot only plays music: never a person on the stage.
    .filter(
      (participant) =>
        !isAuxiliaryIdentity(participant.identity) && !isJamBotIdentity(participant.identity),
    )
    .sort((a, b) => {
      const joinedA = a.joinedAt?.getTime() ?? 0;
      const joinedB = b.joinedAt?.getTime() ?? 0;
      const nameA = a.name || a.identity;
      const nameB = b.name || b.identity;
      return joinedA - joinedB || nameA.localeCompare(nameB, 'pt-BR');
    });
  const streams: RemoteStream[] = [];
  for (const participant of participants) {
    const screen = publicationOf(participant, Track.Source.ScreenShare, Track.Kind.Video);
    if (screen) {
      const audio = publicationOf(participant, Track.Source.ScreenShareAudio, Track.Kind.Audio);
      streams.push(toStream(participant, 'screen', screen, audio));
    }
    const camera = publicationOf(participant, Track.Source.Camera, Track.Kind.Video);
    if (camera) streams.push(toStream(participant, 'camera', camera, null));
  }
  return streams;
}

const STREAM_EVENTS = [
  RoomEvent.Connected,
  RoomEvent.Reconnected,
  RoomEvent.Disconnected,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackSubscriptionFailed,
  RoomEvent.TrackSubscriptionStatusChanged,
  RoomEvent.TrackStreamStateChanged,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.ConnectionQualityChanged,
] as const;

/** Live list of remote screen shares and webcams in `room`, refreshed on every livekit event. */
export function useRemoteStreams(room: Room): RemoteStream[] {
  const [streams, setStreams] = useState<RemoteStream[]>(() => collectRemoteStreams(room));

  useEffect(() => {
    const refresh = (): void => setStreams(collectRemoteStreams(room));
    for (const event of STREAM_EVENTS) room.on(event, refresh);
    // Anything that happened between the first render and this subscription.
    const catchUp = window.setTimeout(refresh, 0);
    return () => {
      window.clearTimeout(catchUp);
      for (const event of STREAM_EVENTS) room.off(event, refresh);
    };
  }, [room]);

  return streams;
}
