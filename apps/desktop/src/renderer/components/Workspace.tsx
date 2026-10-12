import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UserInfo } from '@concord/shared';
import {
  useBroadcast,
  type BroadcastEndReason,
  type BroadcastRequest,
} from '../hooks/useBroadcast';
import { useFullscreen } from '../hooks/useFullscreen';
import { useHotkeys } from '../hooks/useHotkeys';
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
import { DEFAULT_SHORTCUT } from '../lib/constants';
import { formatShortcut } from '../lib/format';
import { knownParticipants } from '../lib/presence';
import { pickFocused } from '../lib/subscriptions';
import { getPlatform, concord, toErrorMessage, type Settings } from '../lib/concord';
import { playTransmissionEnded, playTransmissionStarted } from '../lib/transmissionSounds';
import { AppShell } from './AppShell';
import { BottomBar } from './BottomBar';
import { ConnectionBanner } from './ConnectionBanner';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Stage } from './Stage';
import { UserPanel } from './UserPanel';
import { SourcePicker } from './picker/SourcePicker';
import { SettingsView } from './settings/SettingsView';

interface WorkspaceProps {
  user: UserInfo;
  onRekey(): void;
}

const END_MESSAGES: Record<BroadcastEndReason, string | null> = {
  user: null,
  ended: 'A janela compartilhada foi fechada. Transmissão encerrada.',
  disconnected: 'Transmissão encerrada: a conexão com a sala caiu.',
};

/** The main UI once a session exists: wires presence, rooms, settings, media and main's requests. */
export function Workspace({ user, onRekey }: WorkspaceProps) {
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
    audioPlayback,
    join,
    leave,
    focus,
    startAudio,
  } = useRoom();
  const streams = useRemoteStreams(room);
  const focusedId = pickFocused(streams, focusedParticipantId);
  const connected = connectionState === 'connected';
  useSubscriptions(streams, focusedId, connected);
  const audio = useStreamAudio({
    room,
    connectionState,
    streams,
    outputDeviceId: settings?.audioOutputDeviceId ?? null,
  });
  const { fullscreen, setFullscreen } = useFullscreen();
  const { target, consume } = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Tray / notification clicks: enter the room and focus the stream that triggered it.
  useEffect(() => {
    if (!target) return;
    consume();
    void join(target.room, target.participantId ?? null);
  }, [target, consume, join]);

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
  const platform = getPlatform();
  const shortcutLabel = formatShortcut(settings?.shortcut ?? DEFAULT_SHORTCUT, platform);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useEffect(() => concord().onOpenSettings(openSettings), [openSettings]);

  const openPicker = useCallback(() => {
    if (!settings) {
      toast.show('Aguarde as configurações carregarem.');
      return;
    }
    setSettingsOpen(false);
    setPickerOpen(true);
  }, [settings, toast]);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  const stopBroadcast = useCallback(() => {
    broadcast.stop().catch((err: unknown) => {
      toast.show(toErrorMessage(err, 'Não foi possível parar a transmissão.'), { tone: 'error' });
    });
  }, [broadcast, toast]);

  const startBroadcast = useCallback(
    (request: BroadcastRequest) => {
      broadcast.start(request).then(
        () => {
          setPickerOpen(false);
          playTransmissionStarted();
          toast.show(`Você está ao vivo em #${request.room}.`, { tone: 'success' });
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

  const openPopout = useCallback(() => {
    if (!currentRoom || !focusedId) return;
    concord()
      .openPopout({ room: currentRoom, participantId: focusedId })
      .catch((err: unknown) => {
        toast.show(toErrorMessage(err, 'Não foi possível abrir a janela separada.'), {
          tone: 'error',
        });
      });
  }, [currentRoom, focusedId, toast]);

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
          <ConnectionBanner
            status={status}
            onConnectAnyway={() => saveSettings({ followDiscord: false })}
          />
        }
        sidebar={
          <Sidebar
            rooms={rooms}
            snapshot={snapshot}
            currentRoom={currentRoom}
            onJoin={(roomId) => void join(roomId)}
            onWatch={(roomId, participantId) => void join(roomId, participantId)}
          />
        }
        userPanel={<UserPanel user={user} status={status} onOpenSettings={openSettings} />}
        header={
          <Header
            currentRoom={currentRoom}
            hasFocusedStream={focusedId !== null && connected}
            fullscreen={fullscreen}
            onLeave={() => void leave()}
            onToggleFullscreen={onToggleFullscreen}
            onPopout={openPopout}
            onOpenSettings={openSettings}
          />
        }
        footer={
          <BottomBar
            defaultQuality={settings?.defaultQuality ?? 'standard'}
            broadcast={broadcast.state}
            onStream={openPicker}
            onStop={stopBroadcast}
          />
        }
      >
        <Stage
          currentRoom={currentRoom}
          connectionState={connectionState}
          error={error}
          streams={streams}
          focusedId={focusedId}
          broadcast={broadcast.state}
          audio={audio}
          audioPlayback={audioPlayback}
          fullscreen={fullscreen}
          shortcutLabel={shortcutLabel}
          onFocus={focus}
          onRetry={() => {
            if (currentRoom) void join(currentRoom, focusedParticipantId);
          }}
          onToggleFullscreen={onToggleFullscreen}
          onPopout={openPopout}
          onEnableAudio={enableAudio}
          onStopBroadcast={stopBroadcast}
        />
      </AppShell>
      {pickerOpen && settings && (
        <SourcePicker
          rooms={rooms}
          currentRoom={currentRoom}
          settings={settings}
          starting={broadcast.state.status === 'starting'}
          onCancel={closePicker}
          onStart={startBroadcast}
        />
      )}
      {settingsOpen && settings && (
        <SettingsView
          settings={settings}
          error={settingsError}
          user={user}
          rooms={rooms}
          participants={participants}
          platform={platform}
          version={concord().version}
          onUpdate={saveSettings}
          onClose={closeSettings}
          onRekey={onRekey}
        />
      )}
    </>
  );
}
