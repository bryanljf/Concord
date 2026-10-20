import { useEffect, useMemo, useRef, useState } from 'react';
import { isAuxiliaryIdentity } from '@concord/shared';
import {
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client';
import type { MusicAppId, NowPlaying } from '../../preload/api';
import { concord } from '../lib/concord';
import {
  MUSIC_ART_RPC,
  MUSIC_ATTRIBUTE,
  decodeMusicAttribute,
  parseMusicTrackName,
} from '../lib/music';
import { musicArtDataUrl } from '../lib/musicListening';
import { withPresenceProfiles, type PresenceProfile } from '../lib/presence';

/** Someone broadcasting an app's music in the current livekit room. */
export interface RemoteMusic {
  /** Participant identity (= user id from concord-api). */
  participantId: string;
  /** Presence name when known (follows nickname changes), else the LiveKit name. */
  name: string;
  /** Discord avatar from presence; null when unknown. */
  avatarUrl: string | null;
  participant: RemoteParticipant;
  /** The `concord:music:<app>` publication (source Microphone, `lib/music.ts`). */
  publication: RemoteTrackPublication;
  /** Set once you listen (the publication is subscribed) and the track arrived. */
  track: RemoteAudioTrack | null;
  app: MusicAppId;
  /** What it plays (the `concord.music` attribute); null while unknown or nothing plays. */
  nowPlaying: NowPlaying | null;
  /** Cover art of `nowPlaying.artId` as a data URL; null until fetched, or when there is none. */
  artUrl: string | null;
}

function musicPublicationOf(
  participant: RemoteParticipant,
): { publication: RemoteTrackPublication; app: MusicAppId } | null {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source !== Track.Source.Microphone) continue;
    if (publication.kind !== Track.Kind.Audio) continue;
    const app = parseMusicTrackName(publication.trackName);
    if (app) return { publication, app };
  }
  return null;
}

function audioTrackOf(publication: RemoteTrackPublication): RemoteAudioTrack | null {
  const track = publication.track;
  return track && track.kind === Track.Kind.Audio ? (track as RemoteAudioTrack) : null;
}

/** Every visible participant's music track, sorted by join time (like the stage's streams). */
export function collectRemoteMusic(room: Room): RemoteMusic[] {
  const participants = [...room.remoteParticipants.values()]
    .filter((participant) => !isAuxiliaryIdentity(participant.identity))
    .sort((a, b) => {
      const joinedA = a.joinedAt?.getTime() ?? 0;
      const joinedB = b.joinedAt?.getTime() ?? 0;
      const nameA = a.name || a.identity;
      const nameB = b.name || b.identity;
      return joinedA - joinedB || nameA.localeCompare(nameB, 'pt-BR');
    });
  const music: RemoteMusic[] = [];
  for (const participant of participants) {
    const found = musicPublicationOf(participant);
    if (!found) continue;
    const attribute = decodeMusicAttribute(participant.attributes[MUSIC_ATTRIBUTE]);
    music.push({
      participantId: participant.identity,
      name: participant.name || participant.identity,
      avatarUrl: null,
      participant,
      publication: found.publication,
      track: audioTrackOf(found.publication),
      app: found.app,
      nowPlaying: attribute?.app === found.app ? attribute.nowPlaying : null,
      artUrl: null,
    });
  }
  return music;
}

const MUSIC_EVENTS = [
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
] as const;

/** Covers kept in memory (about 10 KB each); the oldest go first. */
const ART_CACHE_MAX = 48;
/** The broadcaster answers from memory; a slow answer only delays the cover. */
const ART_RPC_TIMEOUT_MS = 8_000;
const ART_RETRY_MS = 3_000;

/**
 * Cover art by `artId`, fetched from each broadcaster with the `concord.music.art` RPC once per
 * (participant, artId) and connection (a failed request is retried once); failures and empty
 * replies are otherwise ignored (placeholder).
 */
function useRemoteMusicArt(room: Room, music: readonly RemoteMusic[]): ReadonlyMap<string, string> {
  const [art, setArt] = useState<ReadonlyMap<string, string>>(() => new Map());
  const attempted = useRef(new Set<string>());

  // A new connection may succeed where the previous one failed.
  useEffect(() => {
    const tried = attempted.current;
    const reset = (): void => tried.clear();
    room.on(RoomEvent.Connected, reset);
    return () => {
      room.off(RoomEvent.Connected, reset);
    };
  }, [room]);

  useEffect(() => {
    const store = (artId: string, url: string): void => {
      setArt((prev) => {
        if (prev.get(artId) === url) return prev;
        const next = new Map(prev);
        next.set(artId, url);
        for (const oldest of next.keys()) {
          if (next.size <= ART_CACHE_MAX) break;
          next.delete(oldest);
        }
        return next;
      });
    };
    const request = (participantId: string, artId: string, retry: boolean): void => {
      room.localParticipant
        .performRpc({
          destinationIdentity: participantId,
          method: MUSIC_ART_RPC,
          payload: JSON.stringify({ artId }),
          responseTimeout: ART_RPC_TIMEOUT_MS,
        })
        .then(
          (reply) => {
            // An empty reply: the broadcaster has no cover for it (placeholder).
            const url = musicArtDataUrl(reply);
            if (url) store(artId, url);
          },
          () => {
            // The broadcaster may not answer yet right after going live: one more try.
            if (retry) window.setTimeout(() => request(participantId, artId, false), ART_RETRY_MS);
          },
        );
    };
    for (const item of music) {
      const artId = item.nowPlaying?.artId;
      if (!artId || art.has(artId)) continue;
      const key = `${item.participantId}\n${artId}`;
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      request(item.participantId, artId, true);
    }
  }, [room, music, art]);

  return art;
}

/**
 * Live list of the music broadcasts in `room` (one per participant: their `concord:music:<app>`
 * track with what it plays and its cover), refreshed on track and participant events and on
 * `concord.music` attribute changes only (the stats attribute every live re-publishes is ignored).
 * Names and avatars come from presence when known.
 */
export function useRemoteMusic(
  room: Room,
  profiles: ReadonlyMap<string, PresenceProfile>,
): RemoteMusic[] {
  const [collected, setCollected] = useState<RemoteMusic[]>(() => collectRemoteMusic(room));

  useEffect(() => {
    const refresh = (): void => setCollected(collectRemoteMusic(room));
    const onAttributesChanged = (changedAttributes: Record<string, string>): void => {
      if (Object.hasOwn(changedAttributes, MUSIC_ATTRIBUTE)) refresh();
    };
    for (const event of MUSIC_EVENTS) room.on(event, refresh);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
    // Anything that happened between the first render and this subscription.
    const catchUp = window.setTimeout(refresh, 0);
    return () => {
      window.clearTimeout(catchUp);
      for (const event of MUSIC_EVENTS) room.off(event, refresh);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
    };
  }, [room]);

  const art = useRemoteMusicArt(room, collected);

  return useMemo(() => {
    const profiled = withPresenceProfiles(collected, profiles);
    let changed = false;
    const withArt = profiled.map((item) => {
      const artId = item.nowPlaying?.artId;
      const artUrl = artId ? (art.get(artId) ?? null) : null;
      if (artUrl === item.artUrl) return item;
      changed = true;
      return { ...item, artUrl };
    });
    return changed ? withArt : profiled;
  }, [collected, profiles, art]);
}

/**
 * Cover art of your own music (`NowPlaying.artId`), straight from main; null while loading,
 * unknown or absent.
 */
export function useOwnMusicArt(artId: string | null): string | null {
  const [loaded, setLoaded] = useState<{ artId: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!artId) return;
    let active = true;
    concord()
      .getMusicArt(artId)
      .then(
        (url) => {
          if (active) setLoaded({ artId, url });
        },
        () => {
          if (active) setLoaded({ artId, url: null });
        },
      );
    return () => {
      active = false;
    };
  }, [artId]);

  return artId && loaded?.artId === artId ? loaded.url : null;
}
