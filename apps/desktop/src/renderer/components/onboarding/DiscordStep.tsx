import { useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { toErrorMessage } from '../../lib/concord';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';

interface DiscordStepProps {
  serverUrl: string;
  user: UserInfo | null;
  onBack(): void;
  onLogin(): Promise<void>;
  onContinue(): void;
}

export function DiscordStep({ serverUrl, user, onBack, onLogin, onContinue }: DiscordStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onLogin();
    } catch (err) {
      setError(toErrorMessage(err, 'Não foi possível entrar com Discord.'));
    } finally {
      setBusy(false);
    }
  }
  if (user) {
    return (
      <div className="onboarding__form onboarding__form--center">
        <Avatar id={user.id} name={user.displayName} src={user.avatarUrl} size="lg" />
        <h1 className="onboarding__title">Olá, {user.displayName}!</h1>
        <p className="onboarding__subtitle">Sua conta Discord foi autorizada pelo servidor.</p>
        <button type="button" className="btn btn--primary" autoFocus onClick={onContinue}>
          Continuar
        </button>
      </div>
    );
  }
  return (
    <div className="onboarding__form">
      <h1 className="onboarding__title">Entrar com Discord</h1>
      <p className="onboarding__subtitle">
        O Concord usa somente sua identidade Discord para confirmar que você pertence ao grupo.
        Servidor: <span className="selectable">{serverUrl}</span>.
      </p>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="onboarding__actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onBack}>
          Alterar servidor
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? (
            <>
              <Spinner size="sm" label="Abrindo" /> Abrindo…
            </>
          ) : (
            'Continuar com Discord'
          )}
        </button>
      </div>
    </div>
  );
}
