import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { NICKNAME_MAX_LENGTH, type UserInfo } from '@concord/shared';
import { useToast } from '../../hooks/useToast';
import { toErrorMessage } from '../../lib/concord';
import { checkNickname, initialNicknameDraft } from '../../lib/nickname';
import { Avatar } from '../Avatar';
import { SettingsSection } from './SettingsSection';

interface AccountSectionProps {
  user: UserInfo;
  serverUrl: string;
  /** Focus the display-name field on mount (opened from the user panel). */
  focusNickname?: boolean;
  onRekey(): void;
  onSetNickname(nickname: string | null): Promise<UserInfo>;
}

export function AccountSection({
  user,
  serverUrl,
  focusNickname = false,
  onRekey,
  onSetNickname,
}: AccountSectionProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  // The draft follows the saved name until the user edits it (also after a save succeeds).
  const savedDraft = initialNicknameDraft(user);
  const [draft, setDraft] = useState(savedDraft);
  const [syncedDraft, setSyncedDraft] = useState(savedDraft);
  if (syncedDraft !== savedDraft) {
    setSyncedDraft(savedDraft);
    setDraft(savedDraft);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = checkNickname(draft, user);
  const dirty = draft !== savedDraft;

  async function save(nickname: string | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const updated = await onSetNickname(nickname);
      toast.show(
        nickname === null
          ? `Pronto! Você voltou a usar o nome do Discord: ${updated.displayName}.`
          : `Nome de exibição alterado para ${updated.displayName}.`,
        { tone: 'success' },
      );
    } catch (err) {
      const message = toErrorMessage(err, 'Não foi possível alterar o nome de exibição.');
      setError(message);
      toast.show(message, { tone: 'error', durationMs: 6000 });
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!check.ok) {
      setError(check.error);
      return;
    }
    void save(check.nickname);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape' || !dirty) return;
    // Esc first discards the edit; only a second Esc reaches the settings view and closes it.
    event.preventDefault();
    event.stopPropagation();
    setDraft(savedDraft);
    setError(null);
  }

  const discordName = user.discordName ?? null;

  return (
    <SettingsSection id="conta" title="Conta">
      <div className="settings__row">
        <span className="settings__label">Conectado como</span>
        <span className="settings__value settings__user">
          <Avatar id={user.id} name={user.displayName} src={user.avatarUrl} size="sm" />
          {user.displayName}
          {user.admin && <span className="settings__tag">admin</span>}
        </span>
      </div>
      <div className="settings__row">
        <span className="settings__label">Servidor</span>
        <span className="settings__value selectable">{serverUrl}</span>
      </div>

      <form className="field settings__nickname" onSubmit={handleSubmit} noValidate>
        <label className="field__label" htmlFor="settings-nickname">
          Nome de exibição
        </label>
        <div className="input-group">
          <input
            id="settings-nickname"
            className="input"
            type="text"
            value={draft}
            maxLength={NICKNAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            autoFocus={focusNickname}
            aria-invalid={error ? true : undefined}
            aria-describedby="settings-nickname-hint"
            readOnly={saving}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
          />
          <button type="submit" className="btn btn--primary" disabled={saving || !check.ok}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <p id="settings-nickname-hint" className="field__hint">
          {discordName ? <>No Discord: {discordName}. </> : null}É assim que os outros veem você nas
          salas e nas transmissões.
        </p>
        <div>
          <button
            type="button"
            className="btn btn--sm"
            disabled={saving || !user.nickname}
            title={user.nickname ? undefined : 'Você já está usando o nome do Discord.'}
            onClick={() => void save(null)}
          >
            Usar nome do Discord
          </button>
        </div>
      </form>

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
