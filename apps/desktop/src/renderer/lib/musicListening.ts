/**
 * The listener side of the music broadcast: who broadcasts music where (presence), which ones you
 * listen to, their volume and the progress bar. Pure so it can be unit-tested;
 * `hooks/useMusicListening.ts` and `components/music/*` drive livekit and the UI with it.
 */
import type { PresenceParticipant, PresenceSnapshot, RoomId } from '@concord/shared';
import type { NowPlaying } from '../../preload/api';
import { MUSIC_ART_MAX_BASE64, extrapolatePosition } from './music';
import { musicKey } from './streamKey';
import {
  DEFAULT_VOLUME_SETTING,
  clampVolume,
  normalizeVolumeSetting,
  toggleMuteSetting,
  type VolumeSetting,
} from './volume';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/** Someone broadcasting music somewhere on the server, as presence sees it. */
export interface PresenceMusic {
  room: RoomId;
  participant: PresenceParticipant;
}

/**
 * Every music broadcast on the server (presence `music === true`, any room): rooms in snapshot
 * order, people by name inside each room.
 */
export function presenceMusic(snapshot: PresenceSnapshot): PresenceMusic[] {
  const found: PresenceMusic[] = [];
  for (const [room, participants] of Object.entries(snapshot.rooms)) {
    const broadcasting = participants
      .filter((participant) => participant.music === true)
      .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.id, b.id));
    for (const participant of broadcasting) found.push({ room, participant });
  }
  return found;
}

/**
 * The broadcasts the room's livekit connection cannot show: every room but the one you are
 * connected to (while connecting or disconnected, the current room's too). Never your own.
 */
export function musicElsewhere(
  all: readonly PresenceMusic[],
  currentRoom: RoomId | null,
  connected: boolean,
  selfId: string,
): PresenceMusic[] {
  return all.filter(
    (entry) => entry.participant.id !== selfId && (!connected || entry.room !== currentRoom),
  );
}

/**
 * What goes in `concord.watching`: the watched streams plus `<id>#music` for each music you listen
 * to (so its broadcaster sees "Ouvindo: N"). Returns `watchedKeys` itself when you listen to
 * nothing, so memoized consumers keep a stable reference.
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

/**
 * The progress bar at `now`: extrapolated while playing, frozen while paused or stopped. A track
 * with no known duration (a live radio, some ads) shows an empty bar.
 */
export function musicProgress(nowPlaying: NowPlaying, now: number): MusicProgress {
  const durationMs = nowPlaying.durationMs;
  const positionMs = extrapolatePosition(nowPlaying, now);
  const fraction = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  return { positionMs, durationMs, fraction };
}

/** Per-broadcaster volume of the music (0–100 % in steps of 1, 50 % by default). */
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

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,/;

/**
 * The `<img>` source for a cover-art RPC reply (a base64 JPEG; an already formed image data URL
 * is accepted too). Null for an empty, oversized or malformed reply: the placeholder stays.
 */
export function musicArtDataUrl(reply: string): string | null {
  const value = reply.trim();
  const prefix = IMAGE_DATA_URL.exec(value)?.[0] ?? '';
  const base64 = value.slice(prefix.length);
  if (base64.length === 0 || base64.length > MUSIC_ART_MAX_BASE64 * 2) return null;
  if (!BASE64.test(base64)) return null;
  return prefix ? value : `data:image/jpeg;base64,${base64}`;
}

/** "Ouvindo: 2" for your own music in the drawer. */
export function listenersLabel(count: number): string {
  return `Ouvindo: ${count}`;
}

/** Tooltip listing who listens: "Ninguém ouvindo ainda" / "Ana e Bia estão ouvindo". */
export function listenersTitle(names: readonly string[]): string {
  if (names.length === 0) return 'Ninguém ouvindo ainda';
  if (names.length === 1) return `${names[0] ?? ''} está ouvindo`;
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1) ?? ''} estão ouvindo`;
}
