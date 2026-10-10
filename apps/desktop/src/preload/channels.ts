/**
 * IPC channel names shared by the main process (`ipcMain.handle` / `webContents.send`)
 * and the preload script (`ipcRenderer.invoke` / `ipcRenderer.on`). Keep this file free of
 * runtime imports: it is bundled into both the main and the sandboxed preload bundle.
 */

/** Renderer → main requests (`invoke`), one per method of `TelaoApi`. */
export const IPC = {
  GET_SESSION: 'session:get',
  LOGIN: 'session:login',
  LOGOUT: 'session:logout',
  GET_SETTINGS: 'settings:get',
  UPDATE_SETTINGS: 'settings:update',
  GET_ROOMS: 'api:rooms',
  REQUEST_TOKEN: 'api:token',
  GET_PRESENCE: 'presence:get',
  /** Fire-and-forget (`send`), not `invoke`. */
  HIDE_TO_TRAY: 'window:hide-to-tray',
  OPEN_EXTERNAL: 'shell:open-external',
} as const;

/** Main → renderer pushes (`webContents.send`), one per `on*` method of `TelaoApi`. */
export const EVENTS = {
  PRESENCE_EVENT: 'presence:event',
  PRESENCE_STATUS: 'presence:status',
  NAVIGATE: 'ui:navigate',
  STREAM_TOGGLE: 'ui:stream-toggle-requested',
  OPEN_SETTINGS: 'ui:open-settings',
  SESSION_CHANGED: 'session:changed',
  SETTINGS_CHANGED: 'settings:changed',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * Envelope returned by every `ipcMain.handle` handler. Errors travel as plain messages so the
 * renderer receives the pt-BR text as-is instead of Electron's "Error invoking remote method"
 * wrapper; the preload turns `ok: false` back into a rejected promise.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; message: string };
