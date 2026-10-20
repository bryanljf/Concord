import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QUALITY_PRESETS, roomLabel, type RoomId, type UserInfo } from '@concord/shared';
import {
  ParticipantEvent,
  Track,
  type LocalTrackPublication,
  type LocalVideoTrack,
} from 'livekit-client';
import type { MusicAppId, PopoutState } from '../../preload/api';
import type { BroadcastSwitchRequest } from '../hooks/useBroadcast';
import {
  useBroadcast,
  type BroadcastEndReason,
  type BroadcastRequest,
} from '../hooks/useBroadcast';
import { useCamera, type CameraEndReason } from '../hooks/useCamera';
import { useFullscreen } from '../hooks/useFullscreen';
import { useHotkeys } from '../hooks/useHotkeys';
import { useLiveStartedSound } from '../hooks/useLiveStartedSound';
import { useMusicBroadcast, type MusicEndReason } from '../hooks/useMusicBroadcast';
import { useMusicListening } from '../hooks/useMusicListening';
import { useMusicStartedSound } from '../hooks/useMusicStartedSound';
import { usePublishStats } from '../hooks/usePublishStats';
import { useRoomSounds } from '../hooks/useRoomSounds';
import { useServerPing } from '../hooks/useServerPing';
import { useNavigate } from '../hooks/useNavigate';
import { usePresence } from '../hooks/usePresence';
import { useRemoteMusic } from '../hooks/useRemoteMusic';
import { useRemoteStreams } from '../hooks/useRemoteStreams';
import { useRoom } from '../hooks/useRoom';
import { useRooms } from '../hooks/useRooms';
import { useSettings } from '../hooks/useSettings';
import { useStreamAudio } from '../hooks/useStreamAudio';
import { useStreamToggle } from '../hooks/useStreamToggle';
import { useSubscriptions } from '../hooks/useSubscriptions';
import { useToast } from '../hooks/useToast';
import { useViewerSounds } from '../hooks/useViewerSounds';
import { useWatchedLiveEndedSound } from '../hooks/useWatchedLiveEndedSound';
import { usePublishWatching, useViewers } from '../hooks/useViewers';
import { DEFAULT_SHORTCUT } from '../lib/constants';
import { formatShortcut } from '../lib/format';
import { MUSIC_APP_LABELS } from '../lib/music';
import { musicElsewhere, presenceMusic, watchingWithMusic } from '../lib/musicListening';
import { musicDuplicationKey, musicDuplicationWarning } from '../lib/musicWarnings';
import { knownParticipants, presenceProfiles, withPresenceProfiles } from '../lib/presence';
import { getPlatform, concord, toErrorMessage, type Settings } from '../lib/concord';
import { computeStageLayout } from '../lib/stageLayout';
import { cameraKey, isCameraKey, musicKey, parseStreamKey } from '../lib/streamKey';
import { playTransmissionEnded, playTransmissionStarted } from '../lib/transmissionSounds';
import { resolveViewers, type Viewer } from '../lib/viewers';
import { AppShell } from './AppShell';
import { BottomBar } from './BottomBar';
import { ConnectionBanner } from './ConnectionBanner';
import { UpdateBanner } from './UpdateBanner';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Stage, type StatsRequest } from './Stage';
import { RoomStatusPanel } from './RoomStatusPanel';
import { UserPanel } from './UserPanel';
import { type MusicCardItem } from './music/MusicCard';
import { MusicDrawer } from './music/MusicDrawer';
import { SourcePicker } from './picker/SourcePicker';
import { SettingsView, type SettingsSectionId } from './settings/SettingsView';
import { StatsPanel, type StatsTarget } from './stats/StatsPanel';

interface WorkspaceProps {
  user: UserInfo;
  onRekey(): void;
  /** Changes the display name (null = Discord name); rejects with a pt-BR message. */
  onSetNickname(nickname: string | null): Promise<UserInfo>;
}

const END_MESSAGES: Record<BroadcastEndReason, string | null> = {
  user: null,
  ended: 'A janela compartilhada foi fechada. Transmissão encerrada.',
  disconnected: 'Transmissão encerrada: a conexão com a sala caiu.',
};

const CAMERA_END_MESSAGES: Record<CameraEndReason, string> = {
  ended: 'A câmera foi desconectada. Câmera desligada.',
  disconnected: 'Câmera desligada: a conexão com a sala caiu.',
};

/** Leaving or switching rooms stops the music first, so a choice never reads as "caiu". */
const MUSIC_END_MESSAGES: Record<MusicEndReason, string> = {
  app_closed: 'O Spotify foi fechado. A música parou.',
  disconnected: 'A música parou: a conexão com a sala caiu.',
  unpublished: 'A música parou.',
};

const CPU_MESSAGE =
  'Seu PC está sem CPU para codificar a transmissão. Se travar, experimente a qualidade Leve.';

/** The webcam's encoder aims at 30 fps (`useCamera`). */
const CAMERA_TARGET_FPS = 30;

const NO_VIEWERS: readonly Viewer[] = [];

const CLOSED_POPOUT: PopoutState = { open: false, target: null };

/** Whether the pop-out window is open and which live it shows (main stops showing that one). */
function usePopoutState(): PopoutState {
  const [state, setState] = useState<PopoutState>(CLOSED_POPOUT);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = concord().onPopoutStateChanged((next) => {
      changed = true;
      if (active) setState(next);
    });
    concord()
      .getPopoutState()
      .then(
        (initial) => {
          // A change event that arrived first is newer than this snapshot.
          if (active && !changed) setState(initial);
        },
        () => undefined,
      );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}

/** Whether the cameras' picture-in-picture window is open. */
function usePipOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = concord().onPipStateChanged((next) => {
      changed = true;
      if (active) setOpen(next.open);
    });
    concord()
      .getPipState()
      .then(
        (initial) => {
          if (active && !changed) setOpen(initial.open);
        },
        () => undefined,
      );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return open;
}

/** The main UI once a session exists: wires presence, rooms, settings, media and main's requests. */
export function Workspace({ user, onRekey, onSetNickname }: WorkspaceProps) {
  const toast = useToast();
  const { settings, error: settingsError, update } = useSettings();
  const { snapshot, status } = usePresence();
  const rooms = useRooms(snapshot, status);
  const {
    room,
    currentRoom,
    connectionState,
    error,
    focusedKey,
    watchedKeys,
    audioPlayback,
    join,
    leave,
    watch,
    unwatch,
    focus,
    showGrid,
    syncLive,
    startAudio,
  } = useRoom();
  const streams = useRemoteStreams(room);
  const connected = connectionState === 'connected';
  const ping = useServerPing(currentRoom !== null);
  const popout = usePopoutState();
  const pipOpen = usePipOpen();
  // Only what the user chose is on the stage: the stream in destaque, if it is (still) published.
  const focusedLiveKey = streams.some((stream) => stream.key === focusedKey) ? focusedKey : null;
  // Watched webcams that are published, in watch order: what the picture-in-picture shows.
  const watchedCameraKeys = useMemo(() => {
    const live = new Set(streams.map((stream) => stream.key));
    return watchedKeys.filter((key) => isCameraKey(key) && live.has(key));
  }, [streams, watchedKeys]);
  // Streams another window shows stay watched (your `concord.watching` lists them) but are
  // neither subscribed nor rendered here: the live in the pop-out, the cameras in the PiP.
  const popoutKey =
    popout.open && popout.target && popout.target.room === currentRoom
      ? popout.target.participantId
      : null;
  const elsewhereKeys = useMemo(() => {
    const keys = pipOpen ? [...watchedCameraKeys] : [];
    if (popoutKey) keys.unshift(popoutKey);
    return keys;
  }, [pipOpen, watchedCameraKeys, popoutKey]);
  useSubscriptions(streams, focusedLiveKey, connected, watchedKeys, elsewhereKeys);
  // A watched stream that ended (stopped streaming, camera off, left the room) leaves the watched
  // list. Only while connected: during a reconnect livekit briefly drops every participant.
  useEffect(() => {
    if (connected) syncLive(streams.map((stream) => stream.key));
  }, [connected, streams, syncLive]);
  // A live you watch went off the air: the same chime the streamer hears when stopping.
  useWatchedLiveEndedSound(streams, watchedKeys, currentRoom, connected);
  // Who watches what: you publish your watched streams (and the music you listen to, below),
  // everyone's attributes give the viewers.
  const viewerIds = useViewers(room);
  // Volume is remembered per participant for their screen share: a webcam (no audio) must not
  // reach it.
  const screenStreams = useMemo(
    () => streams.filter((stream) => stream.kind === 'screen'),
    [streams],
  );
  const audio = useStreamAudio({
    room,
    connectionState,
    streams: screenStreams,
    outputDeviceId: settings?.audioOutputDeviceId ?? null,
  });
  const { fullscreen, setFullscreen } = useFullscreen();
  const { target, consume } = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Section Settings opens on (Conta from the gear and the user panel, Câmera from the camera). */
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('conta');
  /** Opened from the user panel: land on Conta with the display-name field focused. */
  const [editProfile, setEditProfile] = useState(false);
  /** Source picker: 'start' a broadcast, or 'switch' what is shared while live. */
  const [picker, setPicker] = useState<'start' | 'switch' | null>(null);
  const pickerOpen = picker !== null;
  /** "Estatísticas da transmissão": what the panel in the stage's corner shows. */
  const [statsRequest, setStatsRequest] = useState<StatsRequest | null>(null);

  const onCameraEnded = useCallback(
    (reason: CameraEndReason) => {
      toast.show(CAMERA_END_MESSAGES[reason], { tone: 'info', durationMs: 6000 });
    },
    [toast],
  );
  const camera = useCamera({ room, codec: settings?.codec ?? 'h264', onEnded: onCameraEnded });
  // The hook's functions are stable; the object around them is not.
  const { start: startCamera, switchDevice: switchCameraDevice, stop: stopCameraTrack } = camera;
  const cameraActive = camera.state.status === 'on' || camera.state.status === 'starting';

  // Switching rooms ends this room's webcam: turn it off first, so it is not reported as lost.
  const joinRoom = useCallback(
    async (roomId: RoomId, watchKey: string | null = null): Promise<boolean> => {
      if (roomId !== currentRoom && cameraActive) await stopCameraTrack().catch(() => undefined);
      return join(roomId, watchKey);
    },
    [stopCameraTrack, cameraActive, currentRoom, join],
  );

  const onBroadcastWarning = useCallback(
    (message: string, tone: 'info' | 'error') => toast.show(message, { tone, durationMs: 7000 }),
    [toast],
  );

  // The music broadcast (an app's audio on its own track), independent of the screen share.
  const onMusicEnded = useCallback(
    (reason: MusicEndReason) => {
      toast.show(MUSIC_END_MESSAGES[reason], { tone: 'info', durationMs: 6000 });
    },
    [toast],
  );
  const music = useMusicBroadcast({
    room,
    currentRoom,
    join: joinRoom,
    onEnded: onMusicEnded,
    onWarning: onBroadcastWarning,
  });
  const { start: startMusicTrack, stop: stopMusicTrack } = music;
  const musicLive = music.state.status === 'live';

  // The music belongs to its room: switching rooms stops it first (no "caiu" notice for a
  // choice). Only once live: stopping a start in progress would cancel it.
  const enterRoom = useCallback(
    async (roomId: RoomId, watchKey: string | null = null): Promise<boolean> => {
      if (roomId !== currentRoom && musicLive) await stopMusicTrack().catch(() => undefined);
      return joinRoom(roomId, watchKey);
    },
    [stopMusicTrack, musicLive, currentRoom, joinRoom],
  );

  const onBroadcastEnded = useCallback(
    (reason: BroadcastEndReason) => {
      const message = END_MESSAGES[reason];
      if (message) toast.show(message, { tone: 'info', durationMs: 6000 });
    },
    [toast],
  );
  const broadcast = useBroadcast({
    room,
    currentRoom,
    codec: settings?.codec ?? 'h264',
    join: enterRoom,
    onEnded: onBroadcastEnded,
    onWarning: onBroadcastWarning,
  });
  const streaming = broadcast.state.status === 'live' || broadcast.state.status === 'starting';
  const wasStreaming = useRef(false);
  useEffect(() => {
    const active = broadcast.state.status === 'live' || broadcast.state.status === 'starting';
    if (wasStreaming.current && !active && broadcast.state.status === 'idle') {
      playTransmissionEnded();
    }
    wasStreaming.current = active;
  }, [broadcast.state.status]);

  // The encoder cannot keep up (livekit's CPU limitation event): one notice per live.
  const cpuWarned = useRef(false);
  useEffect(() => {
    if (broadcast.state.status === 'starting') cpuWarned.current = false;
  }, [broadcast.state.status]);
  useEffect(() => {
    const local = room.localParticipant;
    const onCpuConstrained = (_track: LocalVideoTrack, publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.ScreenShare || cpuWarned.current) return;
      cpuWarned.current = true;
      toast.show(CPU_MESSAGE, { tone: 'info', durationMs: 10000 });
    };
    local.on(ParticipantEvent.LocalTrackCpuConstrained, onCpuConstrained);
    return () => {
      local.off(ParticipantEvent.LocalTrackCpuConstrained, onCpuConstrained);
    };
  }, [room, toast]);

  // The screen's audio also carries the music app (whole screen, system audio or the app's own
  // window): allowed, with one notice per live and app.
  const duplicationKey = musicDuplicationKey(
    broadcast.state.status === 'live' ? broadcast.state : null,
    music.state.status === 'live' ? music.state : null,
  );
  const musicApp = music.state.status === 'live' ? music.state.app : null;
  const duplicationWarned = useRef<string | null>(null);
  useEffect(() => {
    if (!duplicationKey || !musicApp || duplicationWarned.current === duplicationKey) return;
    duplicationWarned.current = duplicationKey;
    toast.show(musicDuplicationWarning(musicApp), { tone: 'info', durationMs: 10000 });
  }, [duplicationKey, musicApp, toast]);

  // Sender-side statistics of your screen share and webcam (panel + published summary).
  const localScreenTrack =
    broadcast.state.status === 'live'
      ? (room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack ?? null)
      : null;
  const screenTargetFps =
    broadcast.state.status === 'live' ? QUALITY_PRESETS[broadcast.state.quality].fps : 30;
  const localCameraTrack = camera.state.status === 'on' ? camera.state.localTrack : null;
  const statsSources = useMemo(
    () => ({ screen: localScreenTrack, screenTargetFps, camera: localCameraTrack }),
    [localScreenTrack, screenTargetFps, localCameraTrack],
  );
  const publishStats = usePublishStats(room, connected, statsSources);

  // Navigation requests from main (tray, dev --room): enter the room; a target with a participant
  // is an explicit choice to watch that live, so it is watched and put in destaque.
  useEffect(() => {
    if (!target) return;
    consume();
    void enterRoom(target.room, target.participantId ?? null);
  }, [target, consume, enterRoom]);

  // Chime when someone else goes live in this room (Settings → Sons mutes rooms/people).
  const liveSoundContext = useMemo(
    () => ({
      currentRoom,
      connected,
      selfId: user.id,
      mutedRooms: settings?.mutedRooms ?? [],
      mutedUsers: settings?.mutedUsers ?? [],
    }),
    [currentRoom, connected, user.id, settings?.mutedRooms, settings?.mutedUsers],
  );
  useLiveStartedSound(liveSoundContext);
  // Its own chime when someone else starts broadcasting music here (with its own switch).
  const musicSoundContext = useMemo(
    () => ({ ...liveSoundContext, enabled: settings?.musicSounds ?? true }),
    [liveSoundContext, settings?.musicSounds],
  );
  useMusicStartedSound(musicSoundContext);

  // Voice-channel style chimes: people (you included) entering or leaving your room.
  useRoomSounds({
    currentRoom,
    connectionState,
    selfId: user.id,
    enabled: settings?.roomSounds ?? true,
  });

  // Chime when someone starts or stops watching your live or a live you watch (Settings → Sons).
  // Screen shares only (a webcam has no viewer chimes), and only lives still on the air: when
  // one ends, its viewers stop watching without leaving.
  const involvedLiveIds = useMemo(() => {
    const live = new Set(screenStreams.map((stream) => stream.key));
    const watchedLive = watchedKeys.filter((key) => live.has(key));
    return broadcast.state.status === 'live' ? [user.id, ...watchedLive] : watchedLive;
  }, [screenStreams, broadcast.state.status, user.id, watchedKeys]);
  useViewerSounds({
    viewers: viewerIds,
    currentRoom,
    connected,
    involvedLiveIds,
    selfId: user.id,
    enabled: settings?.viewerSounds ?? true,
  });

  const saveSettings = useCallback(
    (patch: Partial<Settings>) => {
      update(patch).catch((err: unknown) => {
        toast.show(toErrorMessage(err, 'Não foi possível salvar as configurações.'), {
          tone: 'error',
        });
      });
    },
    [update, toast],
  );

  const participants = useMemo(() => knownParticipants(snapshot), [snapshot]);
  // LiveKit names are fixed when the token is issued; presence follows nickname/avatar changes.
  const profiles = useMemo(() => presenceProfiles(snapshot), [snapshot]);
  const stageStreams = useMemo(() => withPresenceProfiles(streams, profiles), [streams, profiles]);

  // Listening to music, on demand: the broadcasts in this room (livekit), the ones elsewhere
  // (presence), what you listen to (published as `<id>#music` next to the watched streams).
  const remoteMusic = useRemoteMusic(room, profiles);
  const listening = useMusicListening({
    currentRoom,
    connected,
    music: remoteMusic,
    join: enterRoom,
    startAudio,
  });
  // The music in your room as stage cards ("Ouvir" / "Parar de ouvir"), like the lives' cards.
  const musicCards = useMemo<MusicCardItem[]>(
    () =>
      remoteMusic.map((item) => ({
        participantId: item.participantId,
        name: item.name,
        avatarUrl: item.avatarUrl,
        artUrl: item.artUrl,
        nowPlaying: item.nowPlaying,
        listening: listening.listening.includes(item.participantId),
      })),
    [remoteMusic, listening.listening],
  );
  const publishedWatching = useMemo(
    () => watchingWithMusic(watchedKeys, listening.listening),
    [watchedKeys, listening.listening],
  );
  usePublishWatching(room, connected, publishedWatching);
  const serverMusic = useMemo(() => presenceMusic(snapshot), [snapshot]);
  const elsewhereMusic = useMemo(
    () => musicElsewhere(serverMusic, currentRoom, connected, user.id),
    [serverMusic, currentRoom, connected, user.id],
  );
  const ownMusicActive = music.state.status === 'starting' || musicLive;
  // Presence may lag behind livekit (and your own music) for a moment.
  const musicCount = Math.max(serverMusic.length, remoteMusic.length + (musicLive ? 1 : 0));
  const [musicOpen, setMusicOpen] = useState(false);
  // The drawer closes when the last music ends (the button is gone with it).
  if (musicOpen && musicCount === 0 && !ownMusicActive) setMusicOpen(false);
  const toggleMusic = useCallback(() => setMusicOpen((open) => !open), []);
  const closeMusic = useCallback(() => setMusicOpen(false), []);
  const selfProfile = useMemo(
    () => ({ id: user.id, name: user.displayName, avatarUrl: user.avatarUrl ?? null }),
    [user.id, user.displayName, user.avatarUrl],
  );
  // Viewers by stream key (your camera's viewers are under `cameraKey(user.id)`, your music's
  // listeners under `musicKey(user.id)`).
  const viewers = useMemo(() => {
    const livekitName = (id: string): string | undefined =>
      room.getParticipantByIdentity(id)?.name || undefined;
    const resolved = new Map<string, Viewer[]>();
    for (const [liveId, ids] of viewerIds) {
      resolved.set(liveId, resolveViewers(ids, profiles, livekitName));
    }
    return resolved;
  }, [viewerIds, profiles, room]);
  const platform = getPlatform();
  const shortcutLabel = formatShortcut(settings?.shortcut ?? DEFAULT_SHORTCUT, platform);

  const layout = useMemo(
    () =>
      computeStageLayout({
        liveKeys: streams.map((stream) => stream.key),
        watchedKeys,
        focusedKey: focusedLiveKey,
        elsewhereKeys,
        localScreen: broadcast.state.status === 'live',
        localCamera: camera.state.status === 'on',
        fullscreen,
      }),
    [
      streams,
      watchedKeys,
      focusedLiveKey,
      elsewhereKeys,
      broadcast.state.status,
      camera.state.status,
      fullscreen,
    ],
  );
  // The stream big on the stage and playing here: M mutes it, the header pops it out.
  const effectiveStream = layout.effectiveFocus
    ? (stageStreams.find((stream) => stream.key === layout.effectiveFocus) ?? null)
    : null;
  const effectiveScreen = effectiveStream?.kind === 'screen' ? effectiveStream : null;

  // The statistics panel follows its target and closes when it goes away (live ended, camera
  // off, stream moved to another window or no longer watched).
  let statsTarget: StatsTarget | null = null;
  if (statsRequest?.kind === 'local') {
    if (statsRequest.source === 'screen' && broadcast.state.status === 'live') {
      statsTarget = {
        kind: 'local',
        source: 'screen',
        name: `Sua tela: ${broadcast.state.sourceName}`,
        stats: publishStats.screen,
        targetFps: screenTargetFps,
      };
    } else if (statsRequest.source === 'camera' && camera.state.status === 'on') {
      statsTarget = {
        kind: 'local',
        source: 'camera',
        name: 'Sua câmera',
        stats: publishStats.camera,
        targetFps: CAMERA_TARGET_FPS,
      };
    }
  } else if (statsRequest?.kind === 'remote') {
    const { key } = statsRequest;
    const stream = stageStreams.find((candidate) => candidate.key === key);
    if (stream && watchedKeys.includes(key) && !elsewhereKeys.includes(key)) {
      statsTarget = { kind: 'remote', stream };
    }
  }
  if (statsRequest !== null && statsTarget === null) setStatsRequest(null);
  const closeStats = useCallback(() => setStatsRequest(null), []);

  const openSettingsOn = useCallback((section: SettingsSectionId, profile = false) => {
    setSettingsSection(section);
    setEditProfile(profile);
    setSettingsOpen(true);
  }, []);
  const openSettings = useCallback(() => openSettingsOn('conta'), [openSettingsOn]);
  const openProfile = useCallback(() => openSettingsOn('conta', true), [openSettingsOn]);
  const openCameraSettings = useCallback(() => openSettingsOn('camera'), [openSettingsOn]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useEffect(() => concord().onOpenSettings(openSettings), [openSettings]);

  const openPickerAs = useCallback(
    (mode: 'start' | 'switch') => {
      if (!settings) {
        toast.show('Aguarde as configurações carregarem.');
        return;
      }
      setSettingsOpen(false);
      setPicker(mode);
    },
    [settings, toast],
  );
  const openPicker = useCallback(() => openPickerAs('start'), [openPickerAs]);
  const openSwitchPicker = useCallback(() => openPickerAs('switch'), [openPickerAs]);
  const closePicker = useCallback(() => setPicker(null), []);

  const stopBroadcast = useCallback(() => {
    broadcast.stop().catch((err: unknown) => {
      toast.show(toErrorMessage(err, 'Não foi possível parar a transmissão.'), { tone: 'error' });
    });
  }, [broadcast, toast]);

  const startBroadcast = useCallback(
    (request: BroadcastRequest) => {
      broadcast.start(request).then(
        () => {
          setPicker(null);
          playTransmissionStarted();
          toast.show(`Você está ao vivo em ${roomLabel(request.room)}.`, { tone: 'success' });
        },
        (err: unknown) => {
          toast.show(toErrorMessage(err, 'Não foi possível iniciar a transmissão.'), {
            tone: 'error',
            durationMs: 7000,
          });
        },
      );
    },
    [broadcast, toast],
  );

  // A start the user cancels ("Parar música" while it starts) resolves silently: no success toast.
  const musicStartSeq = useRef(0);
  const startMusic = useCallback(
    (roomId: RoomId, app: MusicAppId) => {
      const seq = ++musicStartSeq.current;
      startMusicTrack(roomId, app).then(
        () => {
          if (seq !== musicStartSeq.current) return;
          setPicker(null);
          toast.show(`Transmitindo música do ${MUSIC_APP_LABELS[app]}.`, { tone: 'success' });
        },
        (err: unknown) => {
          toast.show(toErrorMessage(err, 'Não foi possível transmitir a música.'), {
            tone: 'error',
            durationMs: 7000,
          });
        },
      );
    },
    [startMusicTrack, toast],
  );

  const stopMusic = useCallback(() => {
    musicStartSeq.current += 1;
    stopMusicTrack().catch((err: unknown) => {
      toast.show(toErrorMessage(err, 'Não foi possível parar a música.'), { tone: 'error' });
    });
  }, [stopMusicTrack, toast]);

  const switchSource = useCallback(
    (request: BroadcastSwitchRequest) => {
      broadcast.switchSource(request).then(
        () => {
          setPicker(null);
          toast.show(`Agora transmitindo: ${request.sourceName}`, { tone: 'success' });
        },
        (err: unknown) => {
          // The previous source is still live; the picker stays open to try another one.
          toast.show(toErrorMessage(err, 'Não foi possível trocar a fonte.'), {
            tone: 'error',
            durationMs: 7000,
          });
        },
      );
    },
    [broadcast, toast],
  );

  const stopCamera = useCallback(() => {
    stopCameraTrack().catch((err: unknown) => {
      toast.show(toErrorMessage(err, 'Não foi possível desligar a câmera.'), { tone: 'error' });
    });
  }, [stopCameraTrack, toast]);

  const cameraStopping = camera.state.status === 'stopping';
  const toggleCamera = useCallback(() => {
    if (cameraStopping) return;
    if (cameraActive) {
      stopCamera();
      return;
    }
    if (!currentRoom || !connected) return;
    startCamera(currentRoom, settings?.cameraDeviceId ?? null).catch((err: unknown) => {
      toast.show(toErrorMessage(err, 'Não foi possível ligar a câmera.'), {
        tone: 'error',
        durationMs: 7000,
      });
    });
  }, [
    cameraStopping,
    cameraActive,
    stopCamera,
    startCamera,
    currentRoom,
    connected,
    settings?.cameraDeviceId,
    toast,
  ]);

  // A device picked in the bottom bar's list (or in Settings → Câmera) is remembered; the effect
  // below switches the camera live when it is on.
  const pickCamera = useCallback(
    (deviceId: string | null) => saveSettings({ cameraDeviceId: deviceId }),
    [saveSettings],
  );
  const wantedCameraId = settings?.cameraDeviceId ?? null;
  const cameraDeviceId = camera.state.status === 'on' ? camera.state.deviceId : undefined;
  // Each wanted device is tried once while on (a failed switch keeps the old one, no retry loop).
  const cameraSwitchTried = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (cameraDeviceId === undefined || !settings) {
      cameraSwitchTried.current = undefined;
      return;
    }
    if (cameraDeviceId === wantedCameraId || cameraSwitchTried.current === wantedCameraId) return;
    cameraSwitchTried.current = wantedCameraId;
    switchCameraDevice(wantedCameraId).catch((err: unknown) => {
      toast.show(toErrorMessage(err, 'Não foi possível trocar de câmera.'), {
        tone: 'error',
        durationMs: 7000,
      });
    });
  }, [switchCameraDevice, cameraDeviceId, wantedCameraId, settings, toast]);

  // Cameras' picture-in-picture: opened from a camera's menu, kept in sync with the watched
  // cameras while connected (never while reconnecting: streams briefly vanish), closed when
  // leaving or switching rooms.
  const pipRoom = useRef<RoomId | null>(null);
  const pipSent = useRef<string | null>(null);
  // Participant ids never contain a comma (`^[a-z0-9][a-z0-9_-]{1,31}$`).
  const pipIds = watchedCameraKeys.map((key) => parseStreamKey(key).participantId).join(',');
  const openPip = useCallback(() => {
    if (!currentRoom || !pipIds) return;
    pipRoom.current = currentRoom;
    pipSent.current = pipIds;
    concord()
      .openPip({ room: currentRoom, participantIds: pipIds.split(',') })
      .catch((err: unknown) => {
        toast.show(toErrorMessage(err, 'Não foi possível abrir o picture-in-picture.'), {
          tone: 'error',
        });
      });
  }, [currentRoom, pipIds, toast]);
  const closePip = useCallback(() => {
    concord()
      .closePip()
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (pipOpen && pipRoom.current !== currentRoom) closePip();
  }, [pipOpen, currentRoom, closePip]);
  useEffect(() => {
    if (!pipOpen) {
      pipSent.current = null;
      return;
    }
    if (connectionState !== 'connected' || !currentRoom || pipRoom.current !== currentRoom) return;
    if (pipSent.current === pipIds) return;
    pipSent.current = pipIds;
    // An empty list closes it (the last watched camera stopped or was unwatched).
    concord()
      .updatePip({ room: currentRoom, participantIds: pipIds ? pipIds.split(',') : [] })
      .catch(() => undefined);
  }, [pipOpen, connectionState, currentRoom, pipIds]);

  // Leaving while live stops the broadcast, the music and the camera first (no "a conexão caiu"
  // notice for a choice); the picture-in-picture closes with the room.
  const leaveRoom = useCallback(async () => {
    const status = broadcast.state.status;
    if (status === 'live' || status === 'starting') await broadcast.stop().catch(() => undefined);
    if (musicLive) await stopMusicTrack().catch(() => undefined);
    if (cameraActive) await stopCameraTrack().catch(() => undefined);
    closePip();
    await leave();
  }, [broadcast, musicLive, stopMusicTrack, stopCameraTrack, cameraActive, closePip, leave]);

  // Global shortcut / tray "Transmitir…" keep meaning start/stop.
  useStreamToggle({ streaming, onStart: openPicker, onStop: stopBroadcast });

  const changeFullscreen = useCallback(
    (enabled: boolean) => {
      setFullscreen(enabled).catch((err: unknown) => {
        toast.show(toErrorMessage(err, 'Não foi possível alternar a tela cheia.'), {
          tone: 'error',
        });
      });
    },
    [setFullscreen, toast],
  );
  const onToggleFullscreen = useCallback(() => {
    if (!currentRoom && !fullscreen) return;
    changeFullscreen(!fullscreen);
  }, [currentRoom, fullscreen, changeFullscreen]);

  // Leaving the room (or losing it) while fullscreen would strand the user without chrome.
  useEffect(() => {
    if (fullscreen && !currentRoom) changeFullscreen(false);
  }, [fullscreen, currentRoom, changeFullscreen]);

  const openPopout = useCallback(
    (participantId: string | null) => {
      if (!currentRoom || !participantId) return;
      concord()
        .openPopout({ room: currentRoom, participantId })
        .catch((err: unknown) => {
          toast.show(toErrorMessage(err, 'Não foi possível abrir a janela separada.'), {
            tone: 'error',
          });
        });
    },
    [currentRoom, toast],
  );
  // "Trazer de volta": closing the pop-out makes the live play here again.
  const closePopout = useCallback(() => {
    concord()
      .closePopout()
      .catch(() => undefined);
  }, []);
  const showPopout = useCallback(() => {
    concord()
      .focusPopout()
      .catch(() => undefined);
  }, []);

  const enableAudio = useCallback(() => {
    startAudio().catch(() => {
      toast.show('O áudio continua bloqueado. Tente clicar de novo.', { tone: 'error' });
    });
  }, [startAudio, toast]);

  useEffect(() => {
    if (audio.outputError) toast.show(audio.outputError, { tone: 'error', durationMs: 6000 });
  }, [audio.outputError, toast]);

  useHotkeys(
    {
      onToggleFullscreen,
      // One Esc, one step back: music drawer, statistics panel, picker, fullscreen, destaque →
      // grid.
      onEscape: () => {
        if (musicOpen) closeMusic();
        else if (statsTarget) closeStats();
        else if (pickerOpen) closePicker();
        else if (fullscreen) changeFullscreen(false);
        else if (layout.canShowGrid) showGrid();
      },
      onToggleMute: () => {
        if (pickerOpen || !effectiveScreen || effectiveScreen.audio === null) return;
        audio.toggleMute(effectiveScreen.participantId);
      },
    },
    !settingsOpen,
  );

  return (
    <>
      <AppShell
        immersive={fullscreen}
        banner={
          <>
            <UpdateBanner />
            <ConnectionBanner
              status={status}
              onConnectAnyway={() => saveSettings({ followDiscord: false })}
            />
          </>
        }
        sidebar={
          <Sidebar
            rooms={rooms}
            snapshot={snapshot}
            currentRoom={currentRoom}
            watchedIds={watchedKeys}
            musicListening={listening.listening.length}
            musicOpen={musicOpen}
            onToggleMusic={toggleMusic}
            onJoin={(roomId) => void enterRoom(roomId)}
            onWatch={(roomId, participantId) => void enterRoom(roomId, participantId)}
          />
        }
        userPanel={
          <>
            {currentRoom && (
              <RoomStatusPanel
                room={currentRoom}
                connectionState={connectionState}
                failed={error !== null}
                ping={ping}
                onLeave={() => void leaveRoom()}
              />
            )}
            <UserPanel
              user={user}
              status={status}
              onOpenSettings={openSettings}
              onOpenProfile={openProfile}
            />
          </>
        }
        header={
          <Header
            currentRoom={currentRoom}
            focusedKind={connected ? (effectiveStream?.kind ?? null) : null}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
            onPopout={() => {
              if (effectiveStream?.kind === 'camera') openPip();
              else openPopout(effectiveScreen?.participantId ?? null);
            }}
            onOpenSettings={openSettings}
          />
        }
        footer={
          <BottomBar
            defaultQuality={settings?.defaultQuality ?? 'standard'}
            broadcast={broadcast.state}
            switching={broadcast.switching}
            onStream={openPicker}
            onSwitch={openSwitchPicker}
            onStop={stopBroadcast}
            camera={camera.state}
            cameraSwitching={camera.switching}
            inRoom={connected}
            cameraDeviceId={settings?.cameraDeviceId ?? null}
            onToggleCamera={toggleCamera}
            onPickCamera={pickCamera}
            onCameraSettings={openCameraSettings}
            music={music.state}
            onStopMusic={stopMusic}
          />
        }
        stageOverlay={
          <MusicDrawer
            open={musicOpen}
            self={selfProfile}
            own={music.state}
            ownListeners={viewers.get(musicKey(user.id)) ?? NO_VIEWERS}
            music={remoteMusic}
            elsewhere={elsewhereMusic}
            listening={listening}
            onStopOwn={stopMusic}
            onClose={closeMusic}
          />
        }
      >
        <Stage
          currentRoom={currentRoom}
          connectionState={connectionState}
          error={error}
          streams={stageStreams}
          layout={layout}
          viewers={viewers}
          localViewers={viewers.get(user.id) ?? NO_VIEWERS}
          localCameraViewers={viewers.get(cameraKey(user.id)) ?? NO_VIEWERS}
          broadcast={broadcast.state}
          camera={camera.state}
          audio={audio}
          audioPlayback={audioPlayback}
          pipOpen={pipOpen}
          fullscreen={fullscreen}
          shortcutLabel={shortcutLabel}
          onWatch={watch}
          onUnwatch={unwatch}
          onFocus={focus}
          onShowGrid={showGrid}
          onRetry={() => {
            if (currentRoom) void enterRoom(currentRoom, focusedKey);
          }}
          onToggleFullscreen={onToggleFullscreen}
          onPopout={openPopout}
          onClosePopout={closePopout}
          onShowPopout={showPopout}
          onOpenPip={openPip}
          onClosePip={closePip}
          onStats={setStatsRequest}
          onEnableAudio={enableAudio}
          onStream={openPicker}
          onStopBroadcast={stopBroadcast}
          onSwitchSource={openSwitchPicker}
          onStopCamera={stopCamera}
          onPickCamera={openCameraSettings}
          musicCards={musicCards}
          onListen={listening.listen}
          onStopListening={listening.stop}
        >
          {statsTarget && <StatsPanel target={statsTarget} onClose={closeStats} />}
        </Stage>
      </AppShell>
      {picker === 'start' && settings && (
        <SourcePicker
          music={music.state}
          onStartMusic={startMusic}
          onStopMusic={stopMusic}
          rooms={rooms}
          currentRoom={currentRoom}
          settings={settings}
          starting={broadcast.state.status === 'starting'}
          onCancel={closePicker}
          onStart={startBroadcast}
        />
      )}
      {picker === 'switch' && settings && broadcast.state.status === 'live' && (
        <SourcePicker
          music={music.state}
          onStartMusic={startMusic}
          onStopMusic={stopMusic}
          rooms={rooms}
          currentRoom={broadcast.state.room}
          settings={settings}
          starting={broadcast.switching}
          live={{
            sourceId: broadcast.state.sourceId,
            quality: broadcast.state.quality,
            audio: broadcast.state.audio,
          }}
          onCancel={closePicker}
          onStart={({ sourceId, sourceName, quality, audio: audioMode }) =>
            switchSource({ sourceId, sourceName, quality, audio: audioMode })
          }
        />
      )}
      {settingsOpen && settings && (
        <SettingsView
          settings={settings}
          error={settingsError}
          user={user}
          initialSection={settingsSection}
          focusNickname={editProfile}
          rooms={rooms}
          participants={participants}
          platform={platform}
          version={concord().version}
          onUpdate={saveSettings}
          onClose={closeSettings}
          onRekey={onRekey}
          onSetNickname={onSetNickname}
        />
      )}
    </>
  );
}
