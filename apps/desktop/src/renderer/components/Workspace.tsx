import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { roomLabel, type UserInfo } from '@concord/shared';
import type { BroadcastSwitchRequest } from '../hooks/useBroadcast';
import {
  useBroadcast,
  type BroadcastEndReason,
  type BroadcastRequest,
} from '../hooks/useBroadcast';
import { useFullscreen } from '../hooks/useFullscreen';
import { useHotkeys } from '../hooks/useHotkeys';
import { useLiveStartedSound } from '../hooks/useLiveStartedSound';
import { useRoomSounds } from '../hooks/useRoomSounds';
import { useServerPing } from '../hooks/useServerPing';
import { useNavigate } from '../hooks/useNavigate';
import { usePresence } from '../hooks/usePresence';
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
import { knownParticipants, presenceProfiles, withPresenceProfiles } from '../lib/presence';
import { getPlatform, concord, toErrorMessage, type Settings } from '../lib/concord';
import { playTransmissionEnded, playTransmissionStarted } from '../lib/transmissionSounds';
import { resolveViewers, type Viewer } from '../lib/viewers';
import { AppShell } from './AppShell';
import { BottomBar } from './BottomBar';
import { ConnectionBanner } from './ConnectionBanner';
import { UpdateBanner } from './UpdateBanner';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Stage } from './Stage';
import { RoomStatusPanel } from './RoomStatusPanel';
import { UserPanel } from './UserPanel';
import { SourcePicker } from './picker/SourcePicker';
import { SettingsView } from './settings/SettingsView';

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

const NO_VIEWERS: readonly Viewer[] = [];

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
    focusedParticipantId,
    watchedParticipantIds,
    audioPlayback,
    join,
    leave,
    watch,
    unwatch,
    focus,
    syncLive,
    startAudio,
  } = useRoom();
  const streams = useRemoteStreams(room);
  const connected = connectionState === 'connected';
  const ping = useServerPing(currentRoom !== null);
  // Only what the user chose is on the stage: the focused live, if it is (still) live.
  const focusedId = streams.some((stream) => stream.participantId === focusedParticipantId)
    ? focusedParticipantId
    : null;
  useSubscriptions(streams, focusedId, connected, watchedParticipantIds);
  // A watched live that ended (stopped streaming, left the room) leaves the watched list. Only
  // while connected: during a reconnect livekit briefly drops every participant.
  useEffect(() => {
    if (connected) syncLive(streams.map((stream) => stream.participantId));
  }, [connected, streams, syncLive]);
  // A live you watch went off the air: the same chime the streamer hears when stopping.
  useWatchedLiveEndedSound(streams, watchedParticipantIds, currentRoom, connected);
  // Who watches what: you publish your watched lives, everyone's attributes give the viewers.
  usePublishWatching(room, connected, watchedParticipantIds);
  const viewerIds = useViewers(room);
  const audio = useStreamAudio({
    room,
    connectionState,
    streams,
    outputDeviceId: settings?.audioOutputDeviceId ?? null,
  });
  const { fullscreen, setFullscreen } = useFullscreen();
  const { target, consume } = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Opened from the user panel: land on Conta with the display-name field focused. */
  const [editProfile, setEditProfile] = useState(false);
  /** Source picker: 'start' a broadcast, or 'switch' what is shared while live. */
  const [picker, setPicker] = useState<'start' | 'switch' | null>(null);
  const pickerOpen = picker !== null;

  const onBroadcastEnded = useCallback(
    (reason: BroadcastEndReason) => {
      const message = END_MESSAGES[reason];
      if (message) toast.show(message, { tone: 'info', durationMs: 6000 });
    },
    [toast],
  );
  const onBroadcastWarning = useCallback(
    (message: string, tone: 'info' | 'error') => toast.show(message, { tone, durationMs: 7000 }),
    [toast],
  );
  const broadcast = useBroadcast({
    room,
    currentRoom,
    codec: settings?.codec ?? 'h264',
    join,
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

  // Navigation requests from main (tray, dev --room): enter the room; a target with a participant
  // is an explicit choice to watch that live, so it is watched and focused.
  useEffect(() => {
    if (!target) return;
    consume();
    void join(target.room, target.participantId ?? null);
  }, [target, consume, join]);

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

  // Voice-channel style chimes: people (you included) entering or leaving your room.
  useRoomSounds({
    currentRoom,
    connectionState,
    selfId: user.id,
    enabled: settings?.roomSounds ?? true,
  });

  // Chime when someone starts or stops watching your live or a live you watch (Settings → Sons).
  // Only lives still on the air: when one ends, its viewers stop watching without leaving.
  const involvedLiveIds = useMemo(() => {
    const live = new Set(streams.map((stream) => stream.participantId));
    const watchedLive = watchedParticipantIds.filter((id) => live.has(id));
    return broadcast.state.status === 'live' ? [user.id, ...watchedLive] : watchedLive;
  }, [streams, broadcast.state.status, user.id, watchedParticipantIds]);
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

  const openSettings = useCallback(() => {
    setEditProfile(false);
    setSettingsOpen(true);
  }, []);
  const openProfile = useCallback(() => {
    setEditProfile(true);
    setSettingsOpen(true);
  }, []);
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

  // Leaving while live stops the broadcast first (no "a conexão caiu" notice for a choice).
  const leaveRoom = useCallback(async () => {
    const status = broadcast.state.status;
    if (status === 'live' || status === 'starting') await broadcast.stop().catch(() => undefined);
    await leave();
  }, [broadcast, leave]);

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
      onEscape: () => {
        if (pickerOpen) closePicker();
        else if (fullscreen) changeFullscreen(false);
      },
      onToggleMute: () => {
        if (focusedId && !pickerOpen) audio.toggleMute(focusedId);
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
            watchedIds={watchedParticipantIds}
            onJoin={(roomId) => void join(roomId)}
            onWatch={(roomId, participantId) => void join(roomId, participantId)}
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
            hasFocusedStream={focusedId !== null && connected}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
            onPopout={() => openPopout(focusedId)}
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
          />
        }
      >
        <Stage
          currentRoom={currentRoom}
          connectionState={connectionState}
          error={error}
          streams={stageStreams}
          focusedId={focusedId}
          watchedIds={watchedParticipantIds}
          viewers={viewers}
          localViewers={viewers.get(user.id) ?? NO_VIEWERS}
          broadcast={broadcast.state}
          audio={audio}
          audioPlayback={audioPlayback}
          fullscreen={fullscreen}
          shortcutLabel={shortcutLabel}
          onWatch={watch}
          onUnwatch={unwatch}
          onFocus={focus}
          onRetry={() => {
            if (currentRoom) void join(currentRoom, focusedParticipantId);
          }}
          onToggleFullscreen={onToggleFullscreen}
          onPopout={openPopout}
          onEnableAudio={enableAudio}
          onStopBroadcast={stopBroadcast}
          onSwitchSource={openSwitchPicker}
        />
      </AppShell>
      {picker === 'start' && settings && (
        <SourcePicker
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
          initialSection="conta"
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
