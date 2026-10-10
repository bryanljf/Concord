import type { ReactNode } from 'react';
import type { RoomId } from '@concord/shared';
import type { BroadcastState } from '../hooks/useBroadcast';
import type { RemoteStream } from '../hooks/useRemoteStreams';
import type { RoomConnectionState } from '../hooks/useRoom';
import type { StreamAudio } from '../hooks/useStreamAudio';
import { Spinner } from './Spinner';
import { FocusedStreamTile, MiniStreamTile } from './StreamTile';
import { HeadphonesIcon, MonitorOffIcon, SpeakerIcon, WarningIcon } from './icons';
import { LocalPreviewTile } from './stream/LocalPreviewTile';
import '../styles/stage.css';

interface StageProps {
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /** Remote screen shares in the room (from livekit). */
  streams: RemoteStream[];
  focusedId: string | null;
  broadcast: BroadcastState;
  audio: StreamAudio;
  /** False when playback was blocked until a user gesture. */
  audioPlayback: boolean;
  fullscreen: boolean;
  /** Shortcut already formatted for display, e.g. "Ctrl+Shift+L". */
  shortcutLabel: string;
  onFocus(participantId: string): void;
  onRetry(): void;
  onToggleFullscreen(): void;
  onPopout(): void;
  onEnableAudio(): void;
  onStopBroadcast(): void;
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: 'default' | 'error';
}

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

export function Stage({
  currentRoom,
  connectionState,
  error,
  streams,
  focusedId,
  broadcast,
  audio,
  audioPlayback,
  fullscreen,
  shortcutLabel,
  onFocus,
  onRetry,
  onToggleFullscreen,
  onPopout,
  onEnableAudio,
  onStopBroadcast,
}: StageProps) {
  const live = broadcast.status === 'live';
  const stageClass = live ? 'stage stage--live' : 'stage';

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

  if (error) {
    return (
      <div className="stage">
        <EmptyState
          tone="error"
          icon={<WarningIcon size={64} />}
          title={`Não foi possível entrar em #${currentRoom}`}
        >
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
        <EmptyState icon={<Spinner label="Conectando" />} title={`Entrando em #${currentRoom}…`} />
      </div>
    );
  }

  const focused = streams.find((stream) => stream.participantId === focusedId) ?? null;
  const others = streams.filter((stream) => stream.participantId !== focused?.participantId);
  const localOnStage = broadcast.status === 'live' && !focused;
  const hasStrip = others.length > 0 || (broadcast.status === 'live' && focused !== null);

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
            onPopout={onPopout}
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
          />
        </div>
      ) : (
        <EmptyState
          icon={<MonitorOffIcon size={64} />}
          title={`Ninguém está transmitindo em #${currentRoom}`}
        >
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
              />
            </li>
          )}
          {others.map((stream) => (
            <li key={stream.participantId}>
              <MiniStreamTile stream={stream} onSelect={() => onFocus(stream.participantId)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
