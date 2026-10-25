/**
 * Listening to the Jam on demand: what you listen to (published so the others see you among its
 * listeners), "Ouvir" on a Jam in another room, its volume and the progress bar's shape. The list
 * keeps the shape of "music by participant" (the jam bot is `JAM_BOT_IDENTITY`). Pure so it can
 * be unit-tested; `hooks/useMusicListening.ts` and `components/music/*` drive livekit and the UI
 * with it.
 */
import type { RoomId } from '@concord/shared';
import { musicKey } from './streamKey';
import {
  DEFAULT_VOLUME_SETTING,
  clampVolume,
  normalizeVolumeSetting,
  toggleMuteSetting,
  type VolumeSetting,
} from './volume';

/**
 * What goes in `concord.watching`: the watched streams plus `<id>#music` for each music you listen
 * to (`@jam#music` for the Jam, so everyone sees you among its listeners). Returns `watchedKeys`
 * itself when you listen to nothing, so memoized consumers keep a stable reference.
 */
export function watchingWithMusic(
  watchedKeys: readonly string[],
  listeningIds: readonly string[],
): readonly string[] {
  if (listeningIds.length === 0) return watchedKeys;
  return [...watchedKeys, ...listeningIds.map(musicKey)];
}

/**
 * Starts listening to `id`: one music at a time, so it replaces whatever was playing (the list
 * shape stays, should several ever be allowed).
 */
export function addListening(ids: readonly string[], id: string): readonly string[] {
  return ids.length === 1 && ids[0] === id ? ids : [id];
}

export function removeListening(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : ids;
}

/**
 * Drops the music that went off the air (`available`: the participants whose music track is
 * published). Returns `ids` itself when nothing changes.
 */
export function pruneListening(
  ids: readonly string[],
  available: readonly string[],
): readonly string[] {
  const kept = ids.filter((id) => available.includes(id));
  return kept.length === ids.length ? ids : kept;
}

/** "Ouvir" on a music in another room: entering it, then listening once its track shows up. */
export interface PendingListen {
  room: RoomId;
  participantId: string;
}

/** Wait this long for the room to connect and the music track to appear. */
export const PENDING_LISTEN_TIMEOUT_MS = 15_000;

/**
 * Whether a pending "Ouvir" can start: connected to its room with the music published. Until
 * then it waits (the owner drops it on a timeout or when the user goes to yet another room).
 */
export function pendingListenReady(
  pending: PendingListen,
  currentRoom: RoomId | null,
  connected: boolean,
  available: readonly string[],
): boolean {
  return connected && currentRoom === pending.room && available.includes(pending.participantId);
}

/** Where the progress bar is: times for the labels and the filled fraction (0–1). */
export interface MusicProgress {
  positionMs: number;
  durationMs: number;
  fraction: number;
}

/** Volume of each music by participant (0–100 % in steps of 1, 70 % by default). */
export type MusicVolumes = ReadonlyMap<string, VolumeSetting>;

export function musicVolumeOf(volumes: MusicVolumes, id: string): VolumeSetting {
  return normalizeVolumeSetting(volumes.get(id) ?? DEFAULT_VOLUME_SETTING);
}

/** The slider moved: clamped to whole percents; dragging above zero is an implicit unmute. */
export function withMusicVolume(volumes: MusicVolumes, id: string, volume: number): MusicVolumes {
  const current = musicVolumeOf(volumes, id);
  const clamped = clampVolume(volume);
  const next = new Map(volumes);
  next.set(id, { volume: clamped, muted: clamped === 0 ? current.muted : false });
  return next;
}

/** The mute button (unmuting brings back the previous non-zero volume). */
export function withMusicMuteToggled(volumes: MusicVolumes, id: string): MusicVolumes {
  const next = new Map(volumes);
  next.set(id, toggleMuteSetting(musicVolumeOf(volumes, id)));
  return next;
}
