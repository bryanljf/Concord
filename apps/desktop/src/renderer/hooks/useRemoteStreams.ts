import { useEffect, useState } from 'react';
import { isAuxiliaryIdentity } from '@concord/shared';
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

/** One remote participant's screen share, as seen by livekit (the source of truth on stage). */
export interface RemoteStream {
  /** Participant identity (= user id from concord-api). */
  participantId: string;
  name: string;
  participant: RemoteParticipant;
  video: RemoteTrackPublication | null;
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

function screenPublication(
  participant: RemoteParticipant,
  source: Track.Source,
  kind: Track.Kind,
): RemoteTrackPublication | null {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source === source && publication.kind === kind) return publication;
  }
  return null;
}

/** Snapshot of every visible participant that publishes a screen share (sorted by join time). */
export function collectRemoteStreams(room: Room): RemoteStream[] {
  const streams: RemoteStream[] = [];
  for (const participant of room.remoteParticipants.values()) {
    if (isAuxiliaryIdentity(participant.identity)) continue;
    const video = screenPublication(participant, Track.Source.ScreenShare, Track.Kind.Video);
    if (!video) continue;
    const audio = screenPublication(participant, Track.Source.ScreenShareAudio, Track.Kind.Audio);
    const videoTrack = videoTrackOf(video);
    streams.push({
      participantId: participant.identity,
      name: participant.name || participant.identity,
      participant,
      video,
      audio,
      videoTrack,
      audioTrack: audioTrackOf(audio),
      quality: participant.connectionQuality,
      streamState: videoTrack?.streamState ?? Track.StreamState.Unknown,
      videoMuted: video.isMuted,
    });
  }
  return streams.sort((a, b) => {
    const joinedA = a.participant.joinedAt?.getTime() ?? 0;
    const joinedB = b.participant.joinedAt?.getTime() ?? 0;
    return joinedA - joinedB || a.name.localeCompare(b.name, 'pt-BR');
  });
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

/** Live list of remote screen shares in `room`, refreshed on every relevant livekit event. */
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
