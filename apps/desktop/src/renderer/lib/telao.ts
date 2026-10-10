import type {
  NavigateTarget,
  PresenceConnectionStatus,
  PresenceState,
  Session,
  Settings,
  TelaoApi,
} from '../../preload/api';

export type {
  NavigateTarget,
  PresenceConnectionStatus,
  PresenceState,
  Session,
  Settings,
  TelaoApi,
};

/** The typed bridge exposed by the preload script (`contextBridge`). */
export function telao(): TelaoApi {
  const api: TelaoApi | undefined = window.telao;
  if (!api) throw new Error('A ponte com o aplicativo não está disponível.');
  return api;
}

/** `process.platform` of the main process ("win32" when the bridge is missing, e.g. in tests). */
export function getPlatform(): string {
  if (typeof window === 'undefined') return 'win32';
  const api: TelaoApi | undefined = window.telao;
  return api?.platform ?? 'win32';
}

/** Electron wraps errors thrown by `ipcMain.handle` handlers; strip that wrapper. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

const FALLBACK_MESSAGE = 'Algo deu errado. Tente novamente.';

function hasMessage(value: unknown): value is { message: unknown } {
  return typeof value === 'object' && value !== null && 'message' in value;
}

/** Extracts a user-facing (pt-BR) message from anything that was thrown. */
export function toErrorMessage(err: unknown, fallback = FALLBACK_MESSAGE): string {
  let raw = '';
  if (typeof err === 'string') raw = err;
  else if (hasMessage(err) && typeof err.message === 'string') raw = err.message;
  const cleaned = raw.replace(IPC_WRAPPER, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}
