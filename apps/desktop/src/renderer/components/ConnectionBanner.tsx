import { formatRetryIn } from '../lib/format';
import type { PresenceConnectionStatus } from '../lib/concord';
import { Spinner } from './Spinner';
import { WarningIcon } from './icons';
import '../styles/banner.css';

interface ConnectionBannerProps {
  status: PresenceConnectionStatus;
  /** Disables "Abrir junto com o Discord" so main connects right away. */
  onConnectAnyway(): void;
}

/** Top strip for presence problems; renders nothing while connected or on the first attempt. */
export function ConnectionBanner({ status, onConnectAnyway }: ConnectionBannerProps) {
  switch (status.state) {
    case 'connected':
      return null;
    case 'idle':
      if (status.reason !== 'discord_closed') return null;
      return (
        <div className="banner banner--idle" role="status">
          <span>Discord fechado — presença pausada.</span>
          <button type="button" className="btn btn--sm" onClick={onConnectAnyway}>
            Conectar mesmo assim
          </button>
        </div>
      );
    case 'connecting':
      if (status.attempt <= 1) return null;
      return (
        <div className="banner banner--connecting" role="status">
          <Spinner size="sm" label="Reconectando" />
          <span>Reconectando ao servidor… (tentativa {status.attempt})</span>
        </div>
      );
    case 'error':
      return (
        <div className="banner banner--error" role="alert">
          <WarningIcon size={16} />
          <span>
            Sem conexão com o servidor: {status.message} — nova tentativa em{' '}
            {formatRetryIn(status.retryInMs)}.
          </span>
        </div>
      );
  }
}
