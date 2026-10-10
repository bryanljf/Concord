import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PresenceEvent, RoomId, TokenResponse, UserInfo } from '@concord/shared';
import type {
  CaptureSource,
  ConcordApi,
  NavigateTarget,
  PopoutTarget,
  PresenceConnectionStatus,
  PresenceState,
  ProcessAudioFormat,
  ProcessAudioSupport,
  Session,
  Settings,
  StreamingState,
  UpdateStatus,
} from './api';
import {
  EVENTS,
  IPC,
  WINDOW_KIND_ARG,
  type EventChannel,
  type IpcChannel,
  type IpcResult,
} from './channels';

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
  requestToken: (room, purpose) => invoke<TokenResponse>(IPC.REQUEST_TOKEN, room, purpose),

  getPresence: () => invoke<PresenceState>(IPC.GET_PRESENCE),
  onPresenceEvent: (listener) => subscribe<PresenceEvent>(EVENTS.PRESENCE_EVENT, listener),
  onPresenceStatus: (listener) =>
    subscribe<PresenceConnectionStatus>(EVENTS.PRESENCE_STATUS, listener),

  onNavigate: (listener) => subscribe<NavigateTarget>(EVENTS.NAVIGATE, listener),
  onStreamToggleRequested: (listener) => subscribe<void>(EVENTS.STREAM_TOGGLE, () => listener()),
  onOpenSettings: (listener) => subscribe<void>(EVENTS.OPEN_SETTINGS, () => listener()),

  windowKind: readWindowKind(process.argv),
  hideToTray: () => ipcRenderer.send(IPC.HIDE_TO_TRAY),
  openExternal: (url) => invoke<void>(IPC.OPEN_EXTERNAL, url),
  setFullscreen: (enabled) => invoke<void>(IPC.SET_FULLSCREEN, enabled),
  onFullscreenChanged: (listener) => subscribe<boolean>(EVENTS.FULLSCREEN_CHANGED, listener),

  getCaptureSources: () => invoke<CaptureSource[]>(IPC.GET_CAPTURE_SOURCES),
  selectCaptureSource: (selection) => invoke<void>(IPC.SELECT_CAPTURE_SOURCE, selection),
  setStreamingState: (state) => invoke<void>(IPC.SET_STREAMING_STATE, state),
  getStreamingState: () => invoke<StreamingState>(IPC.GET_STREAMING_STATE),
  onStreamingStateChanged: (listener) =>
    subscribe<StreamingState>(EVENTS.STREAMING_STATE, listener),

  openPopout: (target) => invoke<void>(IPC.OPEN_POPOUT, target),
  closePopout: () => invoke<void>(IPC.CLOSE_POPOUT),
  getPopoutTarget: () => invoke<PopoutTarget | null>(IPC.GET_POPOUT_TARGET),
  setAlwaysOnTop: (enabled) => invoke<void>(IPC.SET_ALWAYS_ON_TOP, enabled),

  getUpdateStatus: () => invoke<UpdateStatus>(IPC.GET_UPDATE_STATUS),
  checkForUpdates: () => invoke<UpdateStatus>(IPC.CHECK_FOR_UPDATES),
  installUpdate: () => invoke<void>(IPC.INSTALL_UPDATE),
  onUpdateStatus: (listener) => subscribe<UpdateStatus>(EVENTS.UPDATE_STATUS, listener),

  getProcessAudioSupport: () => invoke<ProcessAudioSupport>(IPC.PROCESS_AUDIO_SUPPORT),
  startProcessAudio: (sourceId) => invoke<ProcessAudioFormat>(IPC.PROCESS_AUDIO_START, sourceId),
  stopProcessAudio: () => invoke<void>(IPC.PROCESS_AUDIO_STOP),
  onProcessAudioData: (listener) => subscribe<Float32Array>(EVENTS.PROCESS_AUDIO_DATA, listener),
};

/** Main passes `--concord-window=<kind>` through `webPreferences.additionalArguments`. */
function readWindowKind(argv: readonly string[]): 'main' | 'popout' {
  const flag = argv.find((arg) => arg.startsWith(WINDOW_KIND_ARG));
  return flag?.slice(WINDOW_KIND_ARG.length) === 'popout' ? 'popout' : 'main';
}

contextBridge.exposeInMainWorld('concord', api);
