import { useState, type FormEvent } from 'react';
import { normalizeServerUrl } from '../../lib/serverUrl';

interface ServerStepProps {
  value: string;
  onSubmit(url: string): void;
}

export function ServerStep({ value, onSubmit }: ServerStepProps) {
  const [input, setInput] = useState(value);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = normalizeServerUrl(input);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSubmit(result.url);
  }

  return (
    <form className="onboarding__form" onSubmit={handleSubmit}>
      <h1 className="onboarding__title">Bem-vindo ao Telão</h1>
      <p className="onboarding__subtitle">
        Compartilhamento de tela para o grupo, sem depender do Go Live do Discord. Primeiro, diga
        onde está o servidor.
      </p>
      <div className="field">
        <label className="field__label" htmlFor="server-url">
          URL do servidor
        </label>
        <input
          id="server-url"
          className="input"
          type="text"
          inputMode="url"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="http://IP-DO-AMIGO:3000"
          value={input}
          aria-describedby="server-url-hint"
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setInput(event.target.value);
            setError(null);
          }}
        />
        <p className="field__hint" id="server-url-hint">
          Se o servidor roda no PC de um amigo, use o IP dele — ex.: http://IP-DO-AMIGO:3000. Se
          roda na nuvem, use o domínio — ex.: https://telao.exemplo.org.
        </p>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="onboarding__actions">
        <button type="submit" className="btn btn--primary">
          Continuar
        </button>
      </div>
    </form>
  );
}
