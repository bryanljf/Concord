/**
 * The music track in a room: the Jam, played by the server's jam bot as one stereo
 * `Track.Source.Microphone` track named `concord:music:jam` (`JAM_TRACK_NAME`). Used by the
 * listeners (`hooks/useRemoteMusic.ts`), and pure so it can be unit-tested.
 */
import { JAM_TRACK_NAME, isJamBotIdentity } from '@concord/shared';
import { Track } from 'livekit-client';

/** Where a remote music track comes from: the room's Jam, played by the jam bot. */
export type MusicTrackOrigin = { kind: 'jam' };

/**
 * What a participant's track named `trackName` is: `concord:music:jam` counts only from the jam
 * bot (nobody else can pass for the Jam). Null for any other track.
 */
export function musicTrackOrigin(identity: string, trackName: string): MusicTrackOrigin | null {
  return isJamBotIdentity(identity) && trackName === JAM_TRACK_NAME ? { kind: 'jam' } : null;
}

/** The fields of a livekit track publication the music lookup needs. */
export interface MusicPublicationFields {
  source: Track.Source;
  kind: Track.Kind;
  trackName: string;
}

/**
 * A participant's music track among their publications: an audio track with the Microphone source
 * whose name is a music track's (`musicTrackOrigin`). Null when they publish none.
 */
export function findMusicPublication<P extends MusicPublicationFields>(
  identity: string,
  publications: Iterable<P>,
): { publication: P; origin: MusicTrackOrigin } | null {
  for (const publication of publications) {
    if (publication.source !== Track.Source.Microphone) continue;
    if (publication.kind !== Track.Kind.Audio) continue;
    const origin = musicTrackOrigin(identity, publication.trackName);
    if (origin) return { publication, origin };
  }
  return null;
}

/** "3:07" / "1:02:03". */
export function formatTrackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
