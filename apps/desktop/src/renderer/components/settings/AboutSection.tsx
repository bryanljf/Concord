import { PROJECT_URL } from '../../lib/constants';
import { concord } from '../../lib/concord';
import { ExternalLinkIcon } from '../icons';
import { SettingsSection } from './SettingsSection';

interface AboutSectionProps {
  version: string;
  platform: string;
}

export function AboutSection({ version, platform }: AboutSectionProps) {
  return (
    <SettingsSection id="sobre" title="Sobre">
      <dl className="settings__about">
        <dt>Concord</dt>
        <dd>versão {version}</dd>
        <dt>Plataforma</dt>
        <dd>{platform}</dd>
      </dl>
      <div className="settings__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void concord().openExternal(PROJECT_URL)}
        >
          <ExternalLinkIcon size={16} />
          Projeto no GitHub
        </button>
        <button type="button" className="btn btn--sm" disabled title="Em breve">
          Verificar atualizações
        </button>
      </div>
      <p className="field__hint">
        Companion de compartilhamento de tela para o grupo. O Discord continua cuidando da voz e do
        chat.
      </p>
    </SettingsSection>
  );
}
