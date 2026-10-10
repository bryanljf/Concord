import { useCallback, useEffect, useState } from 'react';
import { telao, type NavigateTarget } from '../lib/telao';

export interface UseNavigate {
  /** Pending request from main (tray, notification click); null when none. */
  target: NavigateTarget | null;
  /** Clears the pending target once it has been handled. */
  consume(): void;
}

export function useNavigate(): UseNavigate {
  const [target, setTarget] = useState<NavigateTarget | null>(null);

  useEffect(() => telao().onNavigate((next) => setTarget(next)), []);

  const consume = useCallback(() => setTarget(null), []);

  return { target, consume };
}
