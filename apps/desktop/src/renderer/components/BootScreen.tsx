import { Spinner } from './Spinner';

interface BootScreenProps {
  error?: string | null;
}

/** Shown while the session is loading, or when it could not be loaded at all. */
export function BootScreen({ error = null }: BootScreenProps) {
  if (error) {
    return (
      <div className="boot" role="alert">
        <p className="boot__error">Não foi possível iniciar o Concord: {error}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Tentar de novo
        </button>
      </div>
    );
  }
  return (
    <div className="boot" role="status">
      <Spinner />
      <span>Carregando…</span>
    </div>
  );
}
