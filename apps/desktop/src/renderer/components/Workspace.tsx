import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { useNavigate } from '../hooks/useNavigate';
import { usePresence } from '../hooks/usePresence';
import { useRoom } from '../hooks/useRoom';
import { useRooms } from '../hooks/useRooms';
import { useSettings } from '../hooks/useSettings';
import { useStreamToggle } from '../hooks/useStreamToggle';
import { useToast } from '../hooks/useToast';
import { DEFAULT_SHORTCUT } from '../lib/constants';
import { formatShortcut } from '../lib/format';
import { knownParticipants, resolveFocus, streamersOf } from '../lib/presence';
import { getPlatform, concord, toErrorMessage, type Settings } from '../lib/concord';
import { AppShell } from './AppShell';
import { BottomBar } from './BottomBar';
import { ConnectionBanner } from './ConnectionBanner';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Stage } from './Stage';
import { UserPanel } from './UserPanel';
import { SettingsView } from './settings/SettingsView';

interface WorkspaceProps {
  user: UserInfo;
  onRekey(): void;
}

/** The main UI once a session exists: wires presence, rooms, settings and main's requests. */
export function Workspace({ user, onRekey }: WorkspaceProps) {
  const toast = useToast();
  const { settings, error: settingsError, update } = useSettings();
  const { snapshot, status } = usePresence();
  const rooms = useRooms(snapshot, status);
  const { currentRoom, connectionState, error, focusedParticipantId, join, leave, focus } =
    useRoom();
  const { target, consume } = useNavigate();
  const { requestToggle } = useStreamToggle();
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const streamers = useMemo(
    () => (currentRoom ? streamersOf(snapshot, currentRoom) : []),
    [snapshot, currentRoom],
  );
  const focusedId = resolveFocus(streamers, focusedParticipantId);
  const participants = useMemo(() => knownParticipants(snapshot), [snapshot]);
  const platform = getPlatform();
  const shortcutLabel = formatShortcut(settings?.shortcut ?? DEFAULT_SHORTCUT, platform);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Tray menu "Configurações".
  useEffect(() => concord().onOpenSettings(openSettings), [openSettings]);

  return (
    <>
      <AppShell
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
            onJoin={(room) => void join(room)}
            onWatch={(room, participantId) => void join(room, participantId)}
          />
        }
        userPanel={<UserPanel user={user} status={status} onOpenSettings={openSettings} />}
        header={
          <Header
            currentRoom={currentRoom}
            onLeave={() => void leave()}
            onOpenSettings={openSettings}
          />
        }
        footer={
          <BottomBar quality={settings?.defaultQuality ?? 'standard'} onStream={requestToggle} />
        }
      >
        <Stage
          currentRoom={currentRoom}
          connectionState={connectionState}
          error={error}
          streamers={streamers}
          focusedId={focusedId}
          shortcutLabel={shortcutLabel}
          onFocus={focus}
          onRetry={() => {
            if (currentRoom) void join(currentRoom, focusedParticipantId);
          }}
        />
      </AppShell>
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
