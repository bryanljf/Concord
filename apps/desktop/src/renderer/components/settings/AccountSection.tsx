import { useState } from 'react';
import type { UserInfo } from '@telao/shared';
import { Avatar } from '../Avatar';
import { SettingsSection } from './SettingsSection';

interface AccountSectionProps {
  user: UserInfo;
  serverUrl: string;
  onRekey(): void;
}

export function AccountSection({ user, serverUrl, onRekey }: AccountSectionProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsSection id="conta" title="Conta">
      <div className="settings__row">
        <span className="settings__label">Conectado como</span>
        <span className="settings__value settings__user">
          <Avatar id={user.id} name={user.displayName} size="sm" />
          {user.displayName}
          {user.admin && <span className="settings__tag">admin</span>}
        </span>
      </div>
      <div className="settings__row">
        <span className="settings__label">Servidor</span>
        <span className="settings__value selectable">{serverUrl}</span>
      </div>
      {confirming ? (
        <div className="settings__confirm" role="alert">
          <p>Isso desconecta a conta atual. Você vai precisar colar uma nova chave de acesso.</p>
          <div className="settings__confirm-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={onRekey}>
              Trocar chave
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn--sm" onClick={() => setConfirming(true)}>
            Trocar chave…
          </button>
        </div>
      )}
    </SettingsSection>
  );
}
