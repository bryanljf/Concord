import { useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { toErrorMessage } from '../../lib/concord';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';

interface DiscordStepProps {
  serverUrl: string;
  user: UserInfo | null;
  /** Why the last sign-in failed (web: the OAuth callback's `login_error`); cleared on retry. */
  initialError?: string | null;
  /** "Alterar servidor"; omitted when the server cannot be chosen (web). */
  onBack?(): void;
  onLogin(): Promise<void>;
  /** Fallback for accounts without Discord: sign in with an access key instead (desktop only). */
  onUseKey?(): void;
  onContinue(): void;
}

export function DiscordStep({
  serverUrl,
  user,
  initialError = null,
  onBack,
  onLogin,
  onUseKey,
  onContinue,
}: DiscordStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  // Without a server step this screen is the whole sign-in (the web): the button says so.
  const label = onBack ? 'Continuar com Discord' : 'Entrar com Discord';
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
        {onBack && (
          <>
            {' '}
            Servidor: <span className="selectable">{serverUrl}</span>.
          </>
        )}
      </p>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div
        className={
          onBack ? 'onboarding__actions' : 'onboarding__actions onboarding__actions--center'
        }
      >
        {onBack && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onBack}>
            Alterar servidor
          </button>
        )}
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
            label
          )}
        </button>
      </div>
      {onUseKey && (
        <button type="button" className="btn btn--link" disabled={busy} onClick={onUseKey}>
          Usar uma chave de acesso
        </button>
      )}
    </div>
  );
}
