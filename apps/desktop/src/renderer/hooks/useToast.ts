import { useContext } from 'react';
import { ToastContext, type ToastApi } from '../components/toast/ToastContext';

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
