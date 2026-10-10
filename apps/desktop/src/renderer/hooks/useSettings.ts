import { useCallback, useEffect, useRef, useState } from 'react';
import { telao, toErrorMessage, type Settings } from '../lib/telao';

export interface UseSettings {
  /** Null until loaded. */
  settings: Settings | null;
  loading: boolean;
  error: string | null;
  /** Applies `patch` optimistically, persists it and reverts on failure (rethrows). */
  update(patch: Partial<Settings>): Promise<void>;
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Mirror of `settings` readable from callbacks without re-creating them.
  const latest = useRef<Settings | null>(null);

  useEffect(() => {
    let active = true;
    telao()
      .getSettings()
      .then(
        (loaded) => {
          if (!active) return;
          latest.current = loaded;
          setSettings(loaded);
          setLoading(false);
        },
        (err: unknown) => {
          if (!active) return;
          setError(toErrorMessage(err, 'Não foi possível carregar as configurações.'));
          setLoading(false);
        },
      );
    return () => {
      active = false;
    };
  }, []);

  // Changes made outside this UI (tray checkboxes, dev flags) are pushed by main.
  useEffect(
    () =>
      telao().onSettingsChanged((next) => {
        latest.current = next;
        setSettings(next);
      }),
    [],
  );

  const update = useCallback(async (patch: Partial<Settings>) => {
    const previous = latest.current;
    if (previous) {
      const optimistic = { ...previous, ...patch };
      latest.current = optimistic;
      setSettings(optimistic);
    }
    try {
      const saved = await telao().updateSettings(patch);
      latest.current = saved;
      setSettings(saved);
      setError(null);
    } catch (err) {
      if (previous) {
        latest.current = previous;
        setSettings(previous);
      }
      setError(toErrorMessage(err, 'Não foi possível salvar as configurações.'));
      throw err;
    }
  }, []);

  return { settings, loading, error, update };
}
