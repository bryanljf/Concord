import { useState, type FormEvent } from 'react';
import { useSettings } from '../../hooks/useSettings';
import { DEFAULT_SHORTCUT } from '../../lib/constants';
import { getPlatform, toErrorMessage, type Settings } from '../../lib/concord';
import { ShortcutRecorder } from '../ShortcutRecorder';
import { Spinner } from '../Spinner';

interface PreferencesStepProps {
  onFinish(): void;
}

type Preferences = Pick<Settings, 'launchAtLogin' | 'followDiscord' | 'shortcut'>;

export function PreferencesStep({ onFinish }: PreferencesStepProps) {
  const { settings, loading, update } = useSettings();

  if (loading) {
    return (
      <div className="onboarding__form onboarding__form--center" role="status">
        <Spinner />
        <span className="onboarding__subtitle">Carregando preferências…</span>
      </div>
    );
  }

  // SPEC 5.3: both toggles default to "on"; the shortcut keeps whatever main already has.
  const initial: Preferences = {
    launchAtLogin: true,
    followDiscord: true,
    shortcut: settings?.shortcut ?? DEFAULT_SHORTCUT,
  };

  return <PreferencesForm initial={initial} onSave={update} onFinish={onFinish} />;
}

interface PreferencesFormProps {
  initial: Preferences;
  onSave(patch: Preferences): Promise<void>;
  onFinish(): void;
}

function PreferencesForm({ initial, onSave, onFinish }: PreferencesFormProps) {
  const [launchAtLogin, setLaunchAtLogin] = useState(initial.launchAtLogin);
  const [followDiscord, setFollowDiscord] = useState(initial.followDiscord);
  const [shortcut, setShortcut] = useState(initial.shortcut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ launchAtLogin, followDiscord, shortcut });
      onFinish();
    } catch (err) {
      setError(toErrorMessage(err, 'Não foi possível salvar as preferências.'));
      setBusy(false);
    }
  }

  return (
    <form className="onboarding__form" onSubmit={handleSubmit}>
      <h1 className="onboarding__title">Preferências</h1>
      <p className="onboarding__subtitle">Tudo isso pode ser mudado depois nas configurações.</p>
      <label className="switch">
        <span className="switch__text">
          <span className="switch__title">Iniciar com o Windows</span>
          <span className="switch__desc">Abre escondido na bandeja ao ligar o PC.</span>
        </span>
        <input
          type="checkbox"
          checked={launchAtLogin}
          onChange={(event) => setLaunchAtLogin(event.target.checked)}
        />
      </label>
      <label className="switch">
        <span className="switch__text">
          <span className="switch__title">Abrir junto com o Discord</span>
          <span className="switch__desc">Só fica conectado enquanto o Discord estiver aberto.</span>
        </span>
        <input
          type="checkbox"
          checked={followDiscord}
          onChange={(event) => setFollowDiscord(event.target.checked)}
        />
      </label>
      <div className="field">
        <label className="field__label" htmlFor="onboarding-shortcut">
          Atalho para transmitir
        </label>
        <ShortcutRecorder
          id="onboarding-shortcut"
          value={shortcut}
          platform={getPlatform()}
          onChange={setShortcut}
        />
        <p className="field__hint">Funciona mesmo com o jogo em primeiro plano.</p>
      </div>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="onboarding__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Salvando…' : 'Concluir'}
        </button>
      </div>
    </form>
  );
}
