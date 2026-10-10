import type { ReactNode } from 'react';
import type { PresenceParticipant, RoomId } from '@concord/shared';
import type { RoomConnectionState } from '../hooks/useRoom';
import { Spinner } from './Spinner';
import { StreamTile } from './StreamTile';
import { MonitorOffIcon, SpeakerIcon, WarningIcon } from './icons';
import '../styles/stage.css';

interface StageProps {
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /** Participants of the current room that are streaming (from presence). */
  streamers: PresenceParticipant[];
  focusedId: string | null;
  /** Shortcut already formatted for display, e.g. "Ctrl+Shift+L". */
  shortcutLabel: string;
  onFocus(participantId: string): void;
  onRetry(): void;
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
  streamers,
  focusedId,
  shortcutLabel,
  onFocus,
  onRetry,
}: StageProps) {
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

  const focused = streamers.find((participant) => participant.id === focusedId) ?? null;
  const others = streamers.filter((participant) => participant.id !== focused?.id);

  return (
    <div className="stage">
      {connectionState === 'reconnecting' && (
        <div className="stage__reconnecting" role="status">
          Reconectando à sala…
        </div>
      )}
      {focused ? (
        <>
          <div className="stage__focus">
            <StreamTile participant={focused} focused />
          </div>
          {others.length > 0 && (
            <ul className="stage__strip" aria-label="Outras transmissões">
              {others.map((participant) => (
                <li key={participant.id}>
                  <StreamTile participant={participant} onSelect={() => onFocus(participant.id)} />
                </li>
              ))}
            </ul>
          )}
        </>
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
    </div>
  );
}
