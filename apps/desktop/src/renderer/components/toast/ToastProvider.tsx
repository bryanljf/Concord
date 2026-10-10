import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type ToastApi, type ToastOptions, type ToastTone } from './ToastContext';
import '../../styles/toast.css';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options?: ToastOptions) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((prev) => [
        ...prev.slice(1 - MAX_VISIBLE),
        { id, message, tone: options?.tone ?? 'info' },
      ]);
      window.setTimeout(() => dismiss(id), options?.durationMs ?? DEFAULT_DURATION_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className={`toast toast--${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            title="Fechar"
            onClick={() => dismiss(toast.id)}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
