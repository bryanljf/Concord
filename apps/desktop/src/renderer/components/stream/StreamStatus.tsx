import { Track } from 'livekit-client';
import type { RemoteStream } from '../../hooks/useRemoteStreams';
import { Spinner } from '../Spinner';
import { EyeOffIcon, WarningIcon } from '../icons';

interface StreamStatusProps {
  stream: RemoteStream;
  compact?: boolean;
}

/**
 * What covers the video while it is not playing: waiting for the subscription, the publisher
 * paused it, or the server stopped forwarding it (no bandwidth).
 */
export function StreamStatus({ stream, compact = false }: StreamStatusProps) {
  const what = stream.kind === 'camera' ? 'câmera' : 'transmissão';
  if (!stream.videoTrack) {
    return (
      <div className="tile__status" role="status">
        <Spinner size={compact ? 'sm' : 'md'} label="Conectando" />
        {!compact && (
          <span>
            Conectando à {what} de {stream.name}…
          </span>
        )}
      </div>
    );
  }
  if (stream.videoMuted) {
    return (
      <div className="tile__status" role="status">
        <EyeOffIcon size={compact ? 18 : 28} />
        {!compact && (
          <span>
            {stream.name} pausou a {what}.
          </span>
        )}
      </div>
    );
  }
  if (stream.streamState === Track.StreamState.Paused) {
    return (
      <div className="tile__status tile__status--translucent" role="status">
        <WarningIcon size={compact ? 18 : 28} />
        {!compact && <span>Vídeo pausado: a conexão não está dando conta. Aguardando…</span>}
      </div>
    );
  }
  return null;
}
