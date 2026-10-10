import { useState, type FormEvent } from 'react';
import type { UserInfo } from '@telao/shared';
import { toErrorMessage } from '../../lib/telao';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import { EyeIcon, EyeOffIcon } from '../icons';

interface KeyStepProps {
  serverUrl: string;
  /** Set once the key was validated; switches the step to the greeting. */
  user: UserInfo | null;
  continueLabel: string;
  onBack(): void;
  onLogin(key: string): Promise<void>;
  onContinue(): void;
}

export function KeyStep({
  serverUrl,
  user,
  continueLabel,
  onBack,
  onLogin,
  onContinue,
}: KeyStepProps) {
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      setError('Cole a chave de acesso.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onLogin(trimmed);
    } catch (err) {
      setError(toErrorMessage(err, 'Não foi possível validar a chave.'));
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return (
      <div className="onboarding__form onboarding__form--center">
        <Avatar id={user.id} name={user.displayName} size="lg" />
        <h1 className="onboarding__title">Olá, {user.displayName}!</h1>
        <p className="onboarding__subtitle">
          Chave validada em <span className="selectable">{serverUrl}</span>.
        </p>
        <div className="onboarding__actions onboarding__actions--center">
          <button type="button" className="btn btn--primary" autoFocus onClick={onContinue}>
            {continueLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="onboarding__form" onSubmit={handleSubmit}>
      <h1 className="onboarding__title">Chave de acesso</h1>
      <p className="onboarding__subtitle">
        Cole a chave que você recebeu de quem administra o servidor{' '}
        <span className="selectable">{serverUrl}</span>.
      </p>
      <div className="field">
        <label className="field__label" htmlFor="access-key">
          Chave de acesso
        </label>
        <div className="input-group">
          <input
            id="access-key"
            className="input"
            type={reveal ? 'text' : 'password'}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={key}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setKey(event.target.value);
              setError(null);
            }}
          />
          <button
            type="button"
            className="icon-btn input-group__btn"
            aria-label={reveal ? 'Ocultar chave' : 'Mostrar chave'}
            aria-pressed={reveal}
            onClick={() => setReveal((value) => !value)}
          >
            {reveal ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="onboarding__actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onBack}>
          Alterar servidor
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? (
            <>
              <Spinner size="sm" label="Validando" /> Validando…
            </>
          ) : (
            'Entrar'
          )}
        </button>
      </div>
    </form>
  );
}
