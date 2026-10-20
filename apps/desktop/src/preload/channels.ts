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
  SET_NICKNAME: 'session:set-nickname',
  GET_SETTINGS: 'settings:get',
  UPDATE_SETTINGS: 'settings:update',
  GET_ROOMS: 'api:rooms',
  REQUEST_TOKEN: 'api:token',
  GET_SERVER_INFO: 'api:server',
  PING_SERVER: 'api:ping',
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
  GET_ALWAYS_ON_TOP: 'popout:get-always-on-top',
  GET_POPOUT_STATE: 'popout:get-state',
  FOCUS_POPOUT: 'popout:focus',
  START_WINDOW_DRAG: 'window:drag-start',
  END_WINDOW_DRAG: 'window:drag-end',
  OPEN_PIP: 'pip:open',
  UPDATE_PIP: 'pip:update',
  CLOSE_PIP: 'pip:close',
  GET_PIP_STATE: 'pip:get-state',
  GET_PIP_TARGET: 'pip:get-target',
  SHOW_PIP_MENU: 'pip:menu',
  START_PIP_RESIZE: 'pip:resize-start',
  END_PIP_RESIZE: 'pip:resize-end',
  SET_PIP_FULLSCREEN: 'pip:set-fullscreen',
  GET_UPDATE_STATUS: 'update:get',
  CHECK_FOR_UPDATES: 'update:check',
  INSTALL_UPDATE: 'update:install',
  PROCESS_AUDIO_SUPPORT: 'process-audio:support',
  /** Argument: a `ProcessAudioTarget`; resolves with `{ captureId, format }`. */
  PROCESS_AUDIO_START: 'process-audio:start',
  /** Argument: the `captureId` to stop. */
  PROCESS_AUDIO_STOP: 'process-audio:stop',
  GET_MUSIC_APP_STATUS: 'music:status',
  GET_MUSIC_ART: 'music:art',
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
  POPOUT_STATE: 'popout:state',
  PIP_STATE: 'pip:state',
  /** Picture-in-picture window only: the cameras to show (also every re-target). */
  PIP_TARGET: 'pip:target',
  /** Picture-in-picture window only: entered or left its own (non-native) fullscreen. */
  PIP_FULLSCREEN: 'pip:fullscreen',
  UPDATE_STATUS: 'update:status',
  /** Owning window only: `(captureId, chunk)`. */
  PROCESS_AUDIO_DATA: 'process-audio:data',
  /** Owning window only: `(captureId, reason)` after main ended a capture on its own. */
  PROCESS_AUDIO_ENDED: 'process-audio:ended',
  MUSIC_APP_STATUS: 'music:status-changed',
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
