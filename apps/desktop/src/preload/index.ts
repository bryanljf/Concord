import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  PresenceEvent,
  RoomId,
  ServerInfoResponse,
  TokenResponse,
  UserInfo,
} from '@concord/shared';
import type {
  CaptureSource,
  ConcordApi,
  MusicAppStatus,
  NavigateTarget,
  PipState,
  PipTarget,
  PopoutState,
  PopoutTarget,
  PresenceConnectionStatus,
  PresenceState,
  ProcessAudioCapture,
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
  if (!result.ok) {
    // Error instances crossing the context bridge keep only message/stack, so the failure is
    // rejected as a plain object: the renderer's `toErrorMessage`/`errorCode` accept both.
    const failure: { name: string; message: string; code?: string } = {
      name: 'IpcError',
      message: result.message,
    };
    if (result.code) failure.code = result.code;
    throw failure;
  }
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

/** Same as `subscribe` for pushes with two arguments (e.g. a capture id and its payload). */
function subscribe2<A, B>(channel: EventChannel, listener: (a: A, b: B) => void): () => void {
  const handler = (_event: IpcRendererEvent, a: A, b: B): void => listener(a, b);
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
  loginWithDiscord: (serverUrl) => invoke<UserInfo>(IPC.LOGIN_DISCORD, serverUrl),
  logout: () => invoke<void>(IPC.LOGOUT),
  setNickname: (nickname) => invoke<UserInfo>(IPC.SET_NICKNAME, nickname),

  getSettings: () => invoke<Settings>(IPC.GET_SETTINGS),
  updateSettings: (patch) => invoke<Settings>(IPC.UPDATE_SETTINGS, patch),
  onSettingsChanged: (listener) => subscribe<Settings>(EVENTS.SETTINGS_CHANGED, listener),

  getRooms: () => invoke<RoomId[]>(IPC.GET_ROOMS),
  requestToken: (room, purpose) => invoke<TokenResponse>(IPC.REQUEST_TOKEN, room, purpose),
  getServerInfo: () => invoke<ServerInfoResponse>(IPC.GET_SERVER_INFO),
  pingServer: () => invoke<number>(IPC.PING_SERVER),

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
  getAlwaysOnTop: () => invoke<boolean>(IPC.GET_ALWAYS_ON_TOP),
  getPopoutState: () => invoke<PopoutState>(IPC.GET_POPOUT_STATE),
  onPopoutStateChanged: (listener) => subscribe<PopoutState>(EVENTS.POPOUT_STATE, listener),
  focusPopout: () => invoke<void>(IPC.FOCUS_POPOUT),

  startWindowDrag: () => invoke<void>(IPC.START_WINDOW_DRAG),
  endWindowDrag: () => invoke<void>(IPC.END_WINDOW_DRAG),

  openPip: (target) => invoke<void>(IPC.OPEN_PIP, target),
  updatePip: (target) => invoke<void>(IPC.UPDATE_PIP, target),
  closePip: () => invoke<void>(IPC.CLOSE_PIP),
  getPipState: () => invoke<PipState>(IPC.GET_PIP_STATE),
  onPipStateChanged: (listener) => subscribe<PipState>(EVENTS.PIP_STATE, listener),
  getPipTarget: () => invoke<PipTarget | null>(IPC.GET_PIP_TARGET),
  onPipTarget: (listener) => subscribe<PipTarget>(EVENTS.PIP_TARGET, listener),
  showPipMenu: () => invoke<void>(IPC.SHOW_PIP_MENU),
  startPipResize: (corner) => invoke<void>(IPC.START_PIP_RESIZE, corner),
  endPipResize: () => invoke<void>(IPC.END_PIP_RESIZE),
  setPipFullscreen: (enabled) => invoke<void>(IPC.SET_PIP_FULLSCREEN, enabled),
  onPipFullscreenChanged: (listener) => subscribe<boolean>(EVENTS.PIP_FULLSCREEN, listener),

  getUpdateStatus: () => invoke<UpdateStatus>(IPC.GET_UPDATE_STATUS),
  checkForUpdates: () => invoke<UpdateStatus>(IPC.CHECK_FOR_UPDATES),
  installUpdate: () => invoke<void>(IPC.INSTALL_UPDATE),
  onUpdateStatus: (listener) => subscribe<UpdateStatus>(EVENTS.UPDATE_STATUS, listener),

  getProcessAudioSupport: () => invoke<ProcessAudioSupport>(IPC.PROCESS_AUDIO_SUPPORT),
  startProcessAudio: (target) => invoke<ProcessAudioCapture>(IPC.PROCESS_AUDIO_START, target),
  stopProcessAudio: (captureId) => invoke<void>(IPC.PROCESS_AUDIO_STOP, captureId),
  onProcessAudioData: (listener) =>
    subscribe2<string, Float32Array>(EVENTS.PROCESS_AUDIO_DATA, listener),
  onProcessAudioEnded: (listener) =>
    subscribe2<string, 'app_closed'>(EVENTS.PROCESS_AUDIO_ENDED, listener),

  getMusicAppStatus: (app) => invoke<MusicAppStatus>(IPC.GET_MUSIC_APP_STATUS, app),
  onMusicAppStatus: (listener) => subscribe<MusicAppStatus>(EVENTS.MUSIC_APP_STATUS, listener),
  getMusicArt: (artId) => invoke<string | null>(IPC.GET_MUSIC_ART, artId),
};

/** Main passes `--concord-window=<kind>` through `webPreferences.additionalArguments`. */
function readWindowKind(argv: readonly string[]): ConcordApi['windowKind'] {
  const flag = argv.find((arg) => arg.startsWith(WINDOW_KIND_ARG));
  const kind = flag?.slice(WINDOW_KIND_ARG.length);
  return kind === 'popout' || kind === 'pip' ? kind : 'main';
}

contextBridge.exposeInMainWorld('concord', api);
