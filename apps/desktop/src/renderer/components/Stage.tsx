import { useCallback, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { RoomId } from '@concord/shared';
import type { BroadcastState } from '../hooks/useBroadcast';
import { useContextMenu } from '../hooks/useContextMenu';
import type { RemoteStream } from '../hooks/useRemoteStreams';
import type { RoomConnectionState } from '../hooks/useRoom';
import type { StreamAudio } from '../hooks/useStreamAudio';
import {
  localPreviewMenuItems,
  watchMenuItems,
  type WatchMenuAction,
  type WatchedTileKind,
} from '../lib/contextMenu';
import { liveCardsTitle, stageTitles } from '../lib/stageText';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Spinner } from './Spinner';
import { FocusedStreamTile, MiniStreamTile } from './StreamTile';
import { HeadphonesIcon, MonitorOffIcon, SpeakerIcon, WarningIcon } from './icons';
import { LiveCard } from './stream/LiveCard';
import { LocalPreviewTile } from './stream/LocalPreviewTile';
import '../styles/stage.css';

interface StageProps {
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /** Remote screen shares in the room (from livekit), subscribed or not. */
  streams: RemoteStream[];
  /** The watched live on the stage; null when nothing watched is live. */
  focusedId: string | null;
  /** Lives the user chose to watch, in the order they were picked. */
  watchedIds: readonly string[];
  broadcast: BroadcastState;
  audio: StreamAudio;
  /** False when playback was blocked until a user gesture. */
  audioPlayback: boolean;
  fullscreen: boolean;
  /** Shortcut already formatted for display, e.g. "Ctrl+Shift+L". */
  shortcutLabel: string;
  /** "Assistir": subscribe and put on the stage. */
  onWatch(participantId: string): void;
  /** "Parar de assistir": unsubscribe video and audio. */
  onUnwatch(participantId: string): void;
  /** Mini tile click / "Colocar em destaque": switch between watched lives. */
  onFocus(participantId: string): void;
  onRetry(): void;
  onToggleFullscreen(): void;
  onPopout(participantId: string): void;
  onEnableAudio(): void;
  onStopBroadcast(): void;
  /** "Trocar fonte" from your own preview's menu. */
  onSwitchSource(): void;
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: 'default' | 'error';
}

/** A watched live (by participant), or your own broadcast preview. */
type MenuTarget = { kind: WatchedTileKind; participantId: string } | { kind: 'local' };

const LOCAL_TARGET: MenuTarget = { kind: 'local' };

function EmptyState({ icon, title, children, tone = 'default' }: EmptyStateProps) {
  return (
    <div
      className={tone === 'error' ? 'stage__empty stage__empty--error' : 'stage__empty'}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <div className="stage__icon">{icon}</div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Where the focus goes when the tile that opened the menu is gone. */
function focusedTileElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-focused-live]');
}

export function Stage({
  currentRoom,
  connectionState,
  error,
  streams,
  focusedId,
  watchedIds,
  broadcast,
  audio,
  audioPlayback,
  fullscreen,
  shortcutLabel,
  onWatch,
  onUnwatch,
  onFocus,
  onRetry,
  onToggleFullscreen,
  onPopout,
  onEnableAudio,
  onStopBroadcast,
  onSwitchSource,
}: StageProps) {
  const contextMenu = useContextMenu<MenuTarget>(focusedTileElement);

  const focused = streams.find((stream) => stream.participantId === focusedId) ?? null;
  // Watched lives that are live right now, in the order they were picked (mini tiles).
  const minis = useMemo(() => {
    const byId = new Map(streams.map((stream) => [stream.participantId, stream]));
    return watchedIds
      .filter((id) => id !== focused?.participantId)
      .map((id) => byId.get(id))
      .filter((stream): stream is RemoteStream => stream !== undefined);
  }, [streams, watchedIds, focused]);
  // Lives nobody picked: cards without video, nothing subscribed.
  const cards = useMemo(() => {
    const watched = new Set(watchedIds);
    return streams.filter(
      (stream) =>
        stream.participantId !== focused?.participantId && !watched.has(stream.participantId),
    );
  }, [streams, watchedIds, focused]);

  const runMenuAction = useCallback(
    (action: WatchMenuAction, participantId: string) => {
      switch (action) {
        case 'focus':
          onFocus(participantId);
          break;
        case 'popout':
          onPopout(participantId);
          break;
        case 'mute':
          audio.setMuted(participantId, true);
          break;
        case 'unmute':
          audio.setMuted(participantId, false);
          break;
        case 'stop':
          onUnwatch(participantId);
          break;
      }
    },
    [audio, onFocus, onPopout, onUnwatch],
  );

  if (!currentRoom) {
    return (
      <div className="stage">
        <EmptyState icon={<SpeakerIcon size={64} />} title="Escolha uma sala na barra lateral">
          <p>
            Entrar numa sala não assina nenhum vídeo automaticamente — você escolhe o que assistir.
          </p>
        </EmptyState>
      </div>
    );
  }

  const titles = stageTitles(currentRoom);

  if (error) {
    return (
      <div className="stage">
        <EmptyState tone="error" icon={<WarningIcon size={64} />} title={titles.failed}>
          <p>{error}</p>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Tentar de novo
          </button>
        </EmptyState>
      </div>
    );
  }

  if (connectionState === 'connecting' || connectionState === 'disconnected') {
    return (
      <div className="stage">
        <EmptyState icon={<Spinner label="Conectando" />} title={titles.joining} />
      </div>
    );
  }

  const live = broadcast.status === 'live';
  const stageClass = live ? 'stage stage--live' : 'stage';
  const localOnStage = broadcast.status === 'live' && !focused;
  // With a tile on the stage, the cards of unwatched lives move to the strip.
  const cardsOnStage = !focused && !localOnStage && cards.length > 0;
  const stripCards = cardsOnStage ? [] : cards;
  const hasStrip =
    minis.length > 0 || stripCards.length > 0 || (broadcast.status === 'live' && focused !== null);

  // The menu only exists while its target is still there (a watched live that ended, or a
  // broadcast that stopped, closes it).
  const menu = contextMenu.menu;
  const target = menu?.target ?? null;
  let menuLabel = '';
  let menuItems: ContextMenuItem[] = [];
  if (target?.kind === 'local') {
    if (broadcast.status === 'live') {
      menuLabel = 'Opções da sua transmissão';
      menuItems = localPreviewMenuItems().map((item) => ({
        id: item.action,
        label: item.label,
        danger: item.danger,
        separatorBefore: item.separatorBefore,
        onSelect: item.action === 'switch' ? onSwitchSource : onStopBroadcast,
      }));
    }
  } else if (target) {
    const stillThere =
      target.kind === 'focused'
        ? target.participantId === focused?.participantId
        : minis.some((stream) => stream.participantId === target.participantId);
    const stream = stillThere
      ? streams.find((candidate) => candidate.participantId === target.participantId)
      : undefined;
    if (stream) {
      menuLabel = `Opções da transmissão de ${stream.name}`;
      menuItems = watchMenuItems(target.kind, audio.settingFor(target.participantId).muted).map(
        (item) => ({
          id: item.action,
          label: item.label,
          danger: item.danger,
          separatorBefore: item.separatorBefore,
          onSelect: () => runMenuAction(item.action, target.participantId),
        }),
      );
    }
  }
  const localMenu = {
    onContextMenu: (event: MouseEvent<HTMLElement>) =>
      contextMenu.onContextMenu(event, LOCAL_TARGET),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => contextMenu.onKeyDown(event, LOCAL_TARGET),
  };

  const watchTarget = (kind: WatchedTileKind, participantId: string): MenuTarget => ({
    kind,
    participantId,
  });

  return (
    <div className={stageClass}>
      {connectionState === 'reconnecting' && (
        <div className="stage__notice stage__notice--warning" role="status">
          <Spinner size="sm" label="Reconectando" />
          Reconectando à sala…
        </div>
      )}
      {!audioPlayback && focused && (
        <button
          type="button"
          className="stage__notice stage__notice--action"
          onClick={onEnableAudio}
        >
          <HeadphonesIcon size={16} />
          Clique para ativar o áudio das transmissões
        </button>
      )}
      {live && (
        <div className="stage__live-pill" role="status">
          <span className="stage__live-dot" aria-hidden="true" />
          VOCÊ ESTÁ AO VIVO
        </div>
      )}
      {broadcast.status === 'starting' && (
        <div className="stage__notice" role="status">
          <Spinner size="sm" label="Iniciando" />
          Iniciando a transmissão de {broadcast.sourceName}…
        </div>
      )}

      {focused ? (
        <div className="stage__focus">
          <FocusedStreamTile
            key={focused.participantId}
            stream={focused}
            volume={audio.settingFor(focused.participantId)}
            fullscreen={fullscreen}
            onVolume={(volume) => audio.setVolume(focused.participantId, volume)}
            onToggleMute={() => audio.toggleMute(focused.participantId)}
            onToggleFullscreen={onToggleFullscreen}
            onPopout={() => onPopout(focused.participantId)}
            onContextMenu={(event) =>
              contextMenu.onContextMenu(event, watchTarget('focused', focused.participantId))
            }
            onKeyDown={(event) =>
              contextMenu.onKeyDown(event, watchTarget('focused', focused.participantId))
            }
          />
        </div>
      ) : localOnStage && broadcast.status === 'live' ? (
        <div className="stage__focus">
          <LocalPreviewTile
            track={broadcast.videoTrack}
            sourceName={broadcast.sourceName}
            quality={broadcast.quality}
            hasAudio={broadcast.hasAudio}
            focused
            onStop={onStopBroadcast}
            {...localMenu}
          />
        </div>
      ) : cardsOnStage ? (
        <section className="stage__cards" aria-labelledby="stage-cards-title">
          <header className="stage__cards-header">
            <h2 id="stage-cards-title">{liveCardsTitle(cards.length, currentRoom)}</h2>
            <p>Nenhum vídeo é recebido até você clicar em Assistir.</p>
          </header>
          <ul className="stage__cards-grid">
            {cards.map((stream) => (
              <li key={stream.participantId}>
                <LiveCard
                  participantId={stream.participantId}
                  name={stream.name}
                  avatarUrl={stream.avatarUrl}
                  size="stage"
                  onWatch={() => onWatch(stream.participantId)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <EmptyState icon={<MonitorOffIcon size={64} />} title={titles.nobodyLive}>
          <p>
            Pressione <kbd>{shortcutLabel}</kbd> ou clique em <strong>Transmitir</strong> para
            compartilhar sua tela.
          </p>
        </EmptyState>
      )}

      {hasStrip && !fullscreen && (
        <ul className="stage__strip" aria-label="Outras transmissões">
          {broadcast.status === 'live' && focused && (
            <li key="local">
              <LocalPreviewTile
                track={broadcast.videoTrack}
                sourceName={broadcast.sourceName}
                quality={broadcast.quality}
                hasAudio={broadcast.hasAudio}
                focused={false}
                onStop={onStopBroadcast}
                {...localMenu}
              />
            </li>
          )}
          {minis.map((stream) => (
            <li key={stream.participantId}>
              <MiniStreamTile
                stream={stream}
                onSelect={() => onFocus(stream.participantId)}
                onContextMenu={(event) =>
                  contextMenu.onContextMenu(event, watchTarget('mini', stream.participantId))
                }
                onKeyDown={(event) =>
                  contextMenu.onKeyDown(event, watchTarget('mini', stream.participantId))
                }
              />
            </li>
          ))}
          {stripCards.map((stream) => (
            <li key={`card-${stream.participantId}`}>
              <LiveCard
                participantId={stream.participantId}
                name={stream.name}
                avatarUrl={stream.avatarUrl}
                size="strip"
                onWatch={() => onWatch(stream.participantId)}
              />
            </li>
          ))}
        </ul>
      )}

      {menu && menuItems.length > 0 && (
        <ContextMenu
          point={menu.point}
          label={menuLabel}
          items={menuItems}
          onClose={contextMenu.close}
        />
      )}
    </div>
  );
}
