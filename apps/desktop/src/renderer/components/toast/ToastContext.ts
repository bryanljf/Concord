import { createContext } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  durationMs?: number;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
}

export const ToastContext = createContext<ToastApi | null>(null);
