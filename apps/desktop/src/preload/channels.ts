/**
 * IPC channel names shared by the main process (`ipcMain.handle` / `webContents.send`)
 * and the preload script (`ipcRenderer.invoke` / `ipcRenderer.on`). Keep this file free of
 * runtime imports: it is bundled into both the main and the sandboxed preload bundle.
 */

/** Renderer → main requests (`invoke`), one per method of `ConcordApi`. */
export const IPC = {
  GET_SESSION: 'session:get',
  LOGIN: 'session:login',
  LOGIN_DISCORD: 'session:login-discord',
  LOGOUT: 'session:logout',
  GET_SETTINGS: 'settings:get',
  UPDATE_SETTINGS: 'settings:update',
  GET_ROOMS: 'api:rooms',
  REQUEST_TOKEN: 'api:token',
  GET_PRESENCE: 'presence:get',
  /** Fire-and-forget (`send`), not `invoke`. */
  HIDE_TO_TRAY: 'window:hide-to-tray',
  OPEN_EXTERNAL: 'shell:open-external',
  SET_FULLSCREEN: 'window:set-fullscreen',
  GET_CAPTURE_SOURCES: 'capture:sources',
  SELECT_CAPTURE_SOURCE: 'capture:select',
  SET_STREAMING_STATE: 'streaming:set',
  GET_STREAMING_STATE: 'streaming:get',
  OPEN_POPOUT: 'popout:open',
  CLOSE_POPOUT: 'popout:close',
  GET_POPOUT_TARGET: 'popout:target',
  SET_ALWAYS_ON_TOP: 'popout:always-on-top',
  GET_UPDATE_STATUS: 'update:get',
  CHECK_FOR_UPDATES: 'update:check',
  INSTALL_UPDATE: 'update:install',
  PROCESS_AUDIO_SUPPORT: 'process-audio:support',
  PROCESS_AUDIO_START: 'process-audio:start',
  PROCESS_AUDIO_STOP: 'process-audio:stop',
} as const;

/** Main → renderer pushes (`webContents.send`), one per `on*` method of `ConcordApi`. */
export const EVENTS = {
  PRESENCE_EVENT: 'presence:event',
  PRESENCE_STATUS: 'presence:status',
  NAVIGATE: 'ui:navigate',
  STREAM_TOGGLE: 'ui:stream-toggle-requested',
  OPEN_SETTINGS: 'ui:open-settings',
  SESSION_CHANGED: 'session:changed',
  SETTINGS_CHANGED: 'settings:changed',
  FULLSCREEN_CHANGED: 'window:fullscreen-changed',
  STREAMING_STATE: 'streaming:state',
  UPDATE_STATUS: 'update:status',
  PROCESS_AUDIO_DATA: 'process-audio:data',
} as const;

/** `additionalArguments` flag that tells the preload which window it runs in. */
export const WINDOW_KIND_ARG = '--concord-window=';

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * Envelope returned by every `ipcMain.handle` handler. Errors travel as plain messages so the
 * renderer receives the pt-BR text as-is instead of Electron's "Error invoking remote method"
 * wrapper; the preload turns `ok: false` back into a rejected promise.
 */
export type IpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      /** Machine-readable reason when the renderer must branch (e.g. `discord_not_running`). */
      code?: string;
    };
