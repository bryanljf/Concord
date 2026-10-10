import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PresenceEvent, RoomId, TokenResponse, UserInfo } from '@concord/shared';
import type {
  NavigateTarget,
  PresenceConnectionStatus,
  PresenceState,
  Session,
  Settings,
  ConcordApi,
} from './api';
import { EVENTS, IPC, type EventChannel, type IpcChannel, type IpcResult } from './channels';

/**
 * Injected at build time by `define` in electron.vite.config.ts (the sandboxed preload cannot
 * read package.json). Falls back to 0.0.0 when running un-bundled.
 */
declare const __APP_VERSION__: string | undefined;

/** Calls a main-process handler and turns its `IpcResult` envelope back into a value or Error. */
async function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Subscribes to a main-process push; returns the unsubscribe function. */
function subscribe<T>(channel: EventChannel, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: ConcordApi = {
  platform: process.platform,
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',

  getSession: () => invoke<Session>(IPC.GET_SESSION),
  onSessionChanged: (listener) => subscribe<Session>(EVENTS.SESSION_CHANGED, listener),
  login: (serverUrl, key) => invoke<UserInfo>(IPC.LOGIN, serverUrl, key),
  logout: () => invoke<void>(IPC.LOGOUT),

  getSettings: () => invoke<Settings>(IPC.GET_SETTINGS),
  updateSettings: (patch) => invoke<Settings>(IPC.UPDATE_SETTINGS, patch),
  onSettingsChanged: (listener) => subscribe<Settings>(EVENTS.SETTINGS_CHANGED, listener),

  getRooms: () => invoke<RoomId[]>(IPC.GET_ROOMS),
  requestToken: (room) => invoke<TokenResponse>(IPC.REQUEST_TOKEN, room),

  getPresence: () => invoke<PresenceState>(IPC.GET_PRESENCE),
  onPresenceEvent: (listener) => subscribe<PresenceEvent>(EVENTS.PRESENCE_EVENT, listener),
  onPresenceStatus: (listener) =>
    subscribe<PresenceConnectionStatus>(EVENTS.PRESENCE_STATUS, listener),

  onNavigate: (listener) => subscribe<NavigateTarget>(EVENTS.NAVIGATE, listener),
  onStreamToggleRequested: (listener) => subscribe<void>(EVENTS.STREAM_TOGGLE, () => listener()),
  onOpenSettings: (listener) => subscribe<void>(EVENTS.OPEN_SETTINGS, () => listener()),

  hideToTray: () => ipcRenderer.send(IPC.HIDE_TO_TRAY),
  openExternal: (url) => invoke<void>(IPC.OPEN_EXTERNAL, url),
};

contextBridge.exposeInMainWorld('concord', api);
