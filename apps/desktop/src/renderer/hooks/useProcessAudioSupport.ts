import { useEffect, useState } from 'react';
import type { ProcessAudioSupport } from '../../preload/api';
import { concord, toErrorMessage } from '../lib/concord';

/** Whether per-process audio capture (Phase 3b) is available; null while asking main. */
export function useProcessAudioSupport(): ProcessAudioSupport | null {
  const [support, setSupport] = useState<ProcessAudioSupport | null>(null);

  useEffect(() => {
    let active = true;
    concord()
      .getProcessAudioSupport()
      .then(
        (result) => {
          if (active) setSupport(result);
        },
        (err: unknown) => {
          if (!active) return;
          setSupport({
            supported: false,
            reason: toErrorMessage(err, 'Captura de áudio por processo indisponível.'),
          });
        },
      );
    return () => {
      active = false;
    };
  }, []);

  return support;
}
