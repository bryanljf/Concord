import { useState } from 'react';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { PROJECT_URL } from '../../lib/constants';
import { concord, toErrorMessage } from '../../lib/concord';
import { describeUpdateStatus } from '../../lib/updates';
import { Spinner } from '../Spinner';
import { DownloadIcon, ExternalLinkIcon, RefreshIcon } from '../icons';
import { SettingsSection } from './SettingsSection';

interface AboutSectionProps {
  version: string;
  platform: string;
}

export function AboutSection({ version, platform }: AboutSectionProps) {
  const { status, check, install } = useUpdateStatus();
  const view = describeUpdateStatus(status);
  const [installError, setInstallError] = useState<string | null>(null);

  function restart(): void {
    setInstallError(null);
    install().catch((err: unknown) => {
      setInstallError(toErrorMessage(err, 'Não foi possível reiniciar para atualizar.'));
    });
  }

  return (
    <SettingsSection id="sobre" title="Sobre">
      <dl className="settings__about">
        <dt>Concord</dt>
        <dd>versão {version}</dd>
        <dt>Plataforma</dt>
        <dd>{platform}</dd>
      </dl>
      <div className="settings__update">
        <p
          className={`settings__update-status settings__update-status--${view.tone}`}
          role="status"
        >
          {view.busy && <Spinner size="sm" label="Aguarde" />}
          {view.label}
        </p>
        {status.state === 'downloading' && (
          <progress className="settings__progress" max={100} value={status.percent} />
        )}
        {installError && (
          <p className="field__error" role="alert">
            {installError}
          </p>
        )}
      </div>
      <div className="settings__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void concord().openExternal(PROJECT_URL)}
        >
          <ExternalLinkIcon size={16} />
          Projeto no GitHub
        </button>
        {view.canInstall ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={restart}>
            <DownloadIcon size={16} />
            Reiniciar para atualizar
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm"
            disabled={!view.canCheck}
            data-tooltip={view.canCheck ? undefined : view.label}
            onClick={() => void check()}
          >
            <RefreshIcon size={16} />
            Verificar atualizações
          </button>
        )}
      </div>
      <p className="field__hint">
        Companion de compartilhamento de tela para o grupo. O Discord continua cuidando da voz e do
        chat.
      </p>
    </SettingsSection>
  );
}
