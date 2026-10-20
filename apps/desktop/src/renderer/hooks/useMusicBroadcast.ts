import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoomId } from '@concord/shared';
import {
  ConnectionState,
  RoomEvent,
  Track,
  type LocalTrack,
  type LocalTrackPublication,
  type Room,
  type RpcInvocationData,
  type TrackPublishOptions,
} from 'livekit-client';
import type { MusicAppId, NowPlaying } from '../../preload/api';
import { createProcessAudioTrack, type ProcessAudioTrack } from '../audio/processAudioTrack';
import { concord, errorCode, toErrorMessage } from '../lib/concord';
import {
  AUDIO_QUALITY_SAMPLE_MS,
  MUSIC_MAX_KBPS,
  audioNetworkSample,
  initialAudioQuality,
  nextAudioQuality,
} from '../lib/audioQuality';
import {
  MUSIC_APP_LABELS,
  MUSIC_ART_MAX_BASE64,
  MUSIC_ART_RPC,
  MUSIC_ATTRIBUTE,
  MUSIC_STREAM,
  encodeMusicAttribute,
  musicChanged,
  musicTrackName,
} from '../lib/music';
import { useMusicAppStatus } from './useMusicAppStatus';

export type MusicBroadcastState =
  | { status: 'idle' }
  | { status: 'starting'; app: MusicAppId; room: RoomId }
  | {
      status: 'live';
      app: MusicAppId;
      room: RoomId;
      /** Kept up to date from main's music app status (null: the app plays nothing now). */
      nowPlaying: NowPlaying | null;
      startedAt: number;
      /** Opus bitrate in use right now (adapts to the uplink, aiming for the best). */
      audioKbps: number;
    }
  | { status: 'stopping' };

/** Why the music stopped without the user asking. */
export type MusicEndReason = 'app_closed' | 'disconnected' | 'unpublished';

export interface MusicBroadcast {
  state: MusicBroadcastState;
  /**
   * Captures the app's audio (its own process tree) and publishes it as the separate music
   * track (`lib/music.ts`), joining `room` first when needed; also publishes what it plays
   * (`concord.music` attribute) and answers the cover-art RPC. Rejects with a pt-BR message
   * (e.g. the app is not running); the hook already cleaned up.
   */
  start(room: RoomId, app: MusicAppId): Promise<void>;
  stop(): Promise<void>;
}

export interface UseMusicBroadcastOptions {
  room: Room;
  currentRoom: RoomId | null;
  /** `useRoom().join`: resolves true once connected. */
  join(roomId: RoomId): Promise<boolean>;
  /** The music stopped on its own (app closed, room lost, publication removed). */
  onEnded?(reason: MusicEndReason): void;
  onWarning?(message: string, tone: 'info' | 'error'): void;
}

/** Main rejects `startProcessAudio({ kind: 'app' })` with this code while the app is closed. */
const APP_NOT_RUNNING = 'app_not_running';

/** livekit and `decodeMusicAttribute` only take cover ids up to this length. */
const ART_ID_MAX = 64;

interface Published {
  app: MusicAppId;
  room: RoomId;
  processAudio: ProcessAudioTrack;
  /** The livekit track: the same object across a full reconnect, which republishes it. */
  localTrack: LocalTrack;
  /** Its current publication (a full reconnect republishes the track in a new one). */
  publication: LocalTrackPublication;
}

/** A start() in progress; `cancelled` says why it must be undone once its current await returns. */
interface Attempt {
  cancelled: 'user' | 'disconnected' | null;
}

type FinishReason = 'user' | MusicEndReason;

function publishOptions(app: MusicAppId): TrackPublishOptions {
  return {
    // Only a label for livekit (the app never captures a microphone): it keeps the music's volume
    // apart from the screen's, and older clients, which only look for ScreenShareAudio, skip it.
    source: Track.Source.Microphone,
    name: musicTrackName(app),
    // Never A/V-synced with the screen share or the camera.
    stream: MUSIC_STREAM,
    dtx: false,
    red: false,
    forceStereo: true,
    // Published at the best quality; the adaptive cap below lowers it only when the uplink
    // struggles (livekit-server allows up to 510 kbps in the SDP).
    audioPreset: { maxBitrate: MUSIC_MAX_KBPS * 1000 },
  };
}

/** Read through a call: TypeScript would keep `room.state` narrowed across awaits. */
function isDisconnected(room: Room): boolean {
  return room.state === ConnectionState.Disconnected;
}

function isReconnecting(room: Room): boolean {
  return (
    room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting
  );
}

/** The publication that carries `track` now, if any. */
function publicationOf(room: Room, track: LocalTrack): LocalTrackPublication | undefined {
  for (const publication of room.localParticipant.trackPublications.values()) {
    if (publication.track === track) return publication;
  }
  return undefined;
}

/** `{ "artId": "…" }` → the id; null for anything else. */
function parseArtRequest(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('artId' in parsed)) return null;
  const artId = (parsed as { artId: unknown }).artId;
  return typeof artId === 'string' && artId.length > 0 && artId.length <= ART_ID_MAX ? artId : null;
}

/** The base64 part of main's `data:image/jpeg;base64,…`; '' when unknown or too big for the RPC. */
function artPayload(dataUrl: string | null): string {
  if (!dataUrl) return '';
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return '';
  const base64 = dataUrl.slice(comma + 1);
  return base64.length <= MUSIC_ART_MAX_BASE64 ? base64 : '';
}

/** `MUSIC_ART_RPC` handler: listeners ask for the cover of the `artId` in the attribute. */
async function answerArtRequest(data: RpcInvocationData): Promise<string> {
  const artId = parseArtRequest(data.payload);
  if (!artId) return '';
  const dataUrl = await concord()
    .getMusicArt(artId)
    .catch(() => null);
  return artPayload(dataUrl);
}

/**
 * Caps the music sender at `kbps` (no-op when already there): re-checked on every sample, since a
 * full reconnect republishes the track with a fresh sender at the published preset.
 */
async function applyAudioCap(track: LocalTrack, kbps: number): Promise<void> {
  const sender = track.sender;
  if (!sender) return;
  const params = sender.getParameters();
  if (params.encodings.length === 0) params.encodings = [{}];
  const target = kbps * 1000;
  if (params.encodings.every((encoding) => encoding.maxBitrate === target)) return;
  for (const encoding of params.encodings) encoding.maxBitrate = target;
  await sender.setParameters(params).catch(() => undefined);
}

interface AttributeWriter {
  /** Sends `value` once connected; a newer value replaces one that has not gone out yet. */
  write(value: string): void;
  /** Sends what is pending (after a reconnection). */
  flush(): void;
  /** Forgets what is pending (the participant is gone with the room). */
  drop(): void;
}

/**
 * Serializes the writes of `MUSIC_ATTRIBUTE`: livekit's `setAttributes` waits until the server
 * echoes each value, so two overlapping writes of the same key would time out. Best-effort, like
 * the other attributes: a lost write is fixed by the next change.
 */
function createAttributeWriter(room: Room): AttributeWriter {
  let pending: string | undefined;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pending !== undefined && room.state === ConnectionState.Connected) {
        const value = pending;
        pending = undefined;
        await room.localParticipant
          .setAttributes({ [MUSIC_ATTRIBUTE]: value })
          .catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };
  return {
    write(value) {
      pending = value;
      void run();
    },
    flush() {
      void run();
    },
    drop() {
      pending = undefined;
    },
  };
}

/**
 * Broadcasts a music app (Spotify for now) apart from the screen share: main captures the app's
 * process tree, the audio goes out as `Track.Source.Microphone` named `concord:music:<app>`
 * (stereo, up to 320 kbps adapting to the uplink, no DTX/RED), what it plays goes in the `concord.music` attribute (re-sent
 * only when the track, state, cover or position jump changes) and listeners fetch the cover with
 * the `concord.music.art` RPC. Music is never "ao vivo": main's streaming state is not touched.
 */
export function useMusicBroadcast(options: UseMusicBroadcastOptions): MusicBroadcast {
  const { room, currentRoom, join, onEnded } = options;
  const [state, setState] = useState<MusicBroadcastState>({ status: 'idle' });
  const published = useRef<Published | null>(null);
  const attempt = useRef<Attempt | null>(null);
  /** What listeners were last told this live (null: nothing yet). */
  const sent = useRef<{ nowPlaying: NowPlaying | null } | null>(null);
  const writer = useMemo(() => createAttributeWriter(room), [room]);
  // Latest props, readable from long-running async work without re-creating callbacks.
  const currentRoomRef = useRef(currentRoom);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    currentRoomRef.current = currentRoom;
    onEndedRef.current = onEnded;
  }, [currentRoom, onEnded]);

  const activeApp = state.status === 'starting' || state.status === 'live' ? state.app : null;
  const appStatus = useMusicAppStatus(activeApp ?? 'spotify', activeApp !== null);
  const nowPlaying = appStatus?.running ? appStatus.nowPlaying : null;
  const live = state.status === 'live';

  const release = useCallback(
    async (current: Published, unpublish: boolean) => {
      if (unpublish && !isDisconnected(room)) {
        await room.localParticipant.unpublishTrack(current.localTrack, true).catch(() => undefined);
      }
      await current.processAudio.stop().catch(() => undefined);
      sent.current = null;
      // Gone with the participant when the room is lost; cleared otherwise.
      if (!isDisconnected(room)) writer.write('');
    },
    [room, writer],
  );

  const finish = useCallback(
    async (reason: FinishReason) => {
      const current = published.current;
      if (!current) return;
      published.current = null;
      setState({ status: 'stopping' });
      // Disconnected / unpublished: livekit already removed the publication.
      await release(current, reason === 'user' || reason === 'app_closed');
      setState({ status: 'idle' });
      if (reason !== 'user') onEndedRef.current?.(reason);
    },
    [release],
  );

  // Audio quality: the best Opus stereo the uplink carries cleanly, re-evaluated every 2 s from
  // the sender stats (loss and round trip), stepping down at once and back up after a clean while.
  useEffect(() => {
    if (!live) return;
    let quality = initialAudioQuality();
    let busy = false;
    const timer = window.setInterval(() => {
      const current = published.current;
      if (busy || !current) return;
      busy = true;
      current.localTrack
        .getRTCStatsReport()
        .then(async (report) => {
          if (report) {
            const next = nextAudioQuality(quality, audioNetworkSample(report), Date.now());
            if (next.kbps !== quality.kbps) {
              setState((prev) =>
                prev.status === 'live' ? { ...prev, audioKbps: next.kbps } : prev,
              );
            }
            quality = next;
          }
          await applyAudioCap(current.localTrack, quality.kbps);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, AUDIO_QUALITY_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  // What it plays: published when going live and whenever it changes enough (`musicChanged`),
  // never every second. Waits for main's first answer so listeners do not get a blank first.
  useEffect(() => {
    const current = published.current;
    if (!live || !current || appStatus === null) return;
    const last = sent.current;
    if (last && !musicChanged(last.nowPlaying, nowPlaying)) return;
    sent.current = { nowPlaying };
    writer.write(encodeMusicAttribute(current.app, nowPlaying));
  }, [live, appStatus, nowPlaying, writer]);

  // The cover art, for listeners, while live.
  useEffect(() => {
    if (!live) return;
    room.unregisterRpcMethod(MUSIC_ART_RPC);
    room.registerRpcMethod(MUSIC_ART_RPC, answerArtRequest);
    return () => {
      room.unregisterRpcMethod(MUSIC_ART_RPC);
    };
  }, [room, live]);

  // A full reconnect unpublishes and republishes every local track while the room is reconnecting
  // (`republishAllTracks`, same track in a new publication): that must not end the music, so it
  // is only checked once reconnected.
  useEffect(() => {
    const onUnpublished = (publication: LocalTrackPublication): void => {
      const current = published.current;
      if (!current) return;
      if (publication !== current.publication && publication.track !== current.localTrack) return;
      if (isReconnecting(room)) return;
      // Room.disconnect() unpublishes every track right before emitting `Disconnected`: let that
      // event (same tick) name the reason first.
      queueMicrotask(() => {
        if (published.current === current) void finish('unpublished');
      });
    };
    const onReconnected = (): void => {
      writer.flush();
      const current = published.current;
      if (!current) return;
      const publication = publicationOf(room, current.localTrack);
      if (!publication) {
        void finish('unpublished');
        return;
      }
      current.publication = publication;
      // A full reconnect is a new participant session: tell listeners again what plays.
      if (sent.current) writer.write(encodeMusicAttribute(current.app, sent.current.nowPlaying));
    };
    const onDisconnected = (): void => {
      writer.drop();
      if (attempt.current) attempt.current.cancelled = 'disconnected';
      if (published.current) void finish('disconnected');
    };
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, finish, writer]);

  // Stop the music if the owner unmounts while it plays (or starts).
  useEffect(
    () => () => {
      if (attempt.current) attempt.current.cancelled = 'user';
      const current = published.current;
      published.current = null;
      if (current) void release(current, true);
    },
    [release],
  );

  const start = useCallback(
    async (roomId: RoomId, app: MusicAppId) => {
      if (published.current || attempt.current) {
        throw new Error('A música já está sendo transmitida.');
      }
      const current: Attempt = { cancelled: null };
      attempt.current = current;
      setState({ status: 'starting', app, room: roomId });
      const label = MUSIC_APP_LABELS[app];
      let processAudio: ProcessAudioTrack | null = null;
      let publishing = false;
      let localTrack: LocalTrack | undefined;
      try {
        const inRoom =
          currentRoomRef.current === roomId && room.state === ConnectionState.Connected;
        if (!inRoom) {
          const connected = await join(roomId);
          if (!connected)
            throw new Error('Não foi possível entrar na sala para transmitir a música.');
        }
        if (current.cancelled) throw new Error('cancelled');

        try {
          processAudio = await createProcessAudioTrack({ kind: 'app', app });
        } catch (err) {
          if (errorCode(err) === APP_NOT_RUNNING) {
            throw new Error(`Abra o ${label} para transmitir música.`, { cause: err });
          }
          throw new Error(toErrorMessage(err, `Não foi possível capturar o áudio do ${label}.`), {
            cause: err,
          });
        }
        // Main ends the capture by itself when the app is closed.
        const capture = processAudio;
        let appClosed = false;
        capture.onEnded(() => {
          appClosed = true;
          if (published.current?.processAudio === capture) void finish('app_closed');
        });
        if (current.cancelled) throw new Error('cancelled');

        publishing = true;
        let publication: LocalTrackPublication;
        try {
          publication = await room.localParticipant.publishTrack(
            capture.track,
            publishOptions(app),
          );
        } catch (err) {
          throw new Error('Não foi possível publicar a música na sala.', { cause: err });
        }
        localTrack = publication.track;
        if (!localTrack) throw new Error('Não foi possível publicar a música na sala.');
        if (current.cancelled) throw new Error('cancelled');
        if (appClosed) throw new Error(`O ${label} foi fechado.`);

        published.current = { app, room: roomId, processAudio: capture, localTrack, publication };
        sent.current = null;
        setState({
          status: 'live',
          app,
          room: roomId,
          nowPlaying: null,
          startedAt: Date.now(),
          audioKbps: MUSIC_MAX_KBPS,
        });
      } catch (err) {
        if (publishing && !isDisconnected(room)) {
          const leftover = localTrack ?? processAudio?.track;
          if (leftover) {
            await room.localParticipant.unpublishTrack(leftover, true).catch(() => undefined);
          }
        }
        await processAudio?.stop().catch(() => undefined);
        setState({ status: 'idle' });
        // Stopped (or the window closed) while starting: nothing to report.
        if (current.cancelled === 'user') return;
        if (current.cancelled === 'disconnected') {
          throw new Error('A conexão com a sala caiu antes de a música começar.', { cause: err });
        }
        throw new Error(toErrorMessage(err, 'Não foi possível transmitir a música.'), {
          cause: err,
        });
      } finally {
        if (attempt.current === current) attempt.current = null;
      }
    },
    [room, join, finish],
  );

  const stop = useCallback(async () => {
    if (attempt.current) attempt.current.cancelled = 'user';
    await finish('user');
  }, [finish]);

  // `nowPlaying` follows main live (what listeners got may lag behind by a position drift).
  const exposed = useMemo<MusicBroadcastState>(
    () => (state.status === 'live' ? { ...state, nowPlaying } : state),
    [state, nowPlaying],
  );

  return { state: exposed, start, stop };
}
