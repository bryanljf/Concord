import { useState } from 'react';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import { useToast } from '../hooks/useToast';
import { toErrorMessage } from '../lib/concord';
import '../styles/banner.css';

/** Top strip announcing a downloaded update, with a one-click restart. */
export function UpdateBanner() {
  const { status, install } = useUpdateStatus();
  const toast = useToast();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  if (status.state === 'downloading') {
    return (
      <div className="banner banner--update" role="status">
        <span>
          Baixando o Concord {status.version}… {Math.round(status.percent)}%
        </span>
      </div>
    );
  }
  if (status.state !== 'ready' || dismissed === status.version) return null;

  const restart = (): void => {
    setInstalling(true);
    install().catch((err: unknown) => {
      setInstalling(false);
      toast.show(toErrorMessage(err, 'Não foi possível instalar a atualização.'), {
        tone: 'error',
      });
    });
  };

  return (
    <div className="banner banner--update" role="status">
      <span>Nova versão do Concord ({status.version}) pronta para instalar.</span>
      <button type="button" className="btn btn--sm" onClick={restart} disabled={installing}>
        {installing ? 'Reiniciando…' : 'Reiniciar agora'}
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() => setDismissed(status.version)}
      >
        Depois
      </button>
    </div>
  );
}
