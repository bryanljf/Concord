import { useEffect, useState } from 'react';
import {
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client';
import { findMusicPublication } from '../lib/music';

/**
 * A music track in the room, what listening needs: the Jam's, the jam bot's `concord:music:jam`.
 * What it plays, the queue and who asked for what come from the jam state (`hooks/useJam.ts`),
 * never from the bot's attributes.
 */
export interface ListenableMusic {
  /** Participant identity: `JAM_BOT_IDENTITY`. */
  participantId: string;
  participant: RemoteParticipant;
  /** The `concord:music:jam` publication (source Microphone). */
  publication: RemoteTrackPublication;
  /** Set once you listen (the publication is subscribed) and the track arrived. */
  track: RemoteAudioTrack | null;
}

const NO_MUSIC: readonly ListenableMusic[] = [];

function audioTrackOf(publication: RemoteTrackPublication): RemoteAudioTrack | null {
  const track = publication.track;
  return track && track.kind === Track.Kind.Audio ? (track as RemoteAudioTrack) : null;
}

/** The room's Jam track, when the jam bot publishes one (between songs it publishes nothing). */
export function collectRoomMusic(room: Room): readonly ListenableMusic[] {
  for (const participant of room.remoteParticipants.values()) {
    const found = findMusicPublication(
      participant.identity,
      participant.trackPublications.values(),
    );
    if (!found) continue;
    const { publication } = found;
    return [
      {
        participantId: participant.identity,
        participant,
        publication,
        track: audioTrackOf(publication),
      },
    ];
  }
  return NO_MUSIC;
}

function sameMusic(a: readonly ListenableMusic[], b: readonly ListenableMusic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.participant === other.participant &&
      entry.publication === other.publication &&
      entry.track === other.track
    );
  });
}

const MUSIC_EVENTS = [
  RoomEvent.Connected,
  RoomEvent.Reconnected,
  RoomEvent.Disconnected,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackSubscriptionFailed,
] as const;

/**
 * The music in `room` you can listen to: the Jam's track while the jam bot publishes it (none or
 * one entry). Refreshed on track and participant events; the same list while nothing changed.
 */
export function useRemoteMusic(room: Room): readonly ListenableMusic[] {
  const [music, setMusic] = useState<readonly ListenableMusic[]>(() => collectRoomMusic(room));

  useEffect(() => {
    const refresh = (): void => {
      const next = collectRoomMusic(room);
      setMusic((prev) => (sameMusic(prev, next) ? prev : next));
    };
    for (const event of MUSIC_EVENTS) room.on(event, refresh);
    // Anything that happened between the first render and this subscription.
    const catchUp = window.setTimeout(refresh, 0);
    return () => {
      window.clearTimeout(catchUp);
      for (const event of MUSIC_EVENTS) room.off(event, refresh);
    };
  }, [room]);

  return music;
}
