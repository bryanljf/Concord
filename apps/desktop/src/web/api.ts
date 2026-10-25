/**
 * The browser's implementation of `ConcordApi` (`window.concord`), the same contract the
 * Electron preload exposes, so the renderer runs unchanged: `fetch` with the session cookie
 * instead of IPC + Bearer, `EventSource` instead of main's SSE client, `localStorage` instead of
 * `settings.json`. Everything that needs Electron or Windows rejects with `UnsupportedError`
 * (the renderer hides it through `capabilities`); getters the renderer calls on mount answer
 * with sane empties instead.
 */
import type { TokenRequest, TokenResponse } from '@concord/shared';
import type {
  ClientCapabilities,
  ConcordApi,
  PopoutState,
  ProcessAudioSupport,
  Session,
  StreamingState,
  UpdateStatus,
} from '../preload/api';
import { browserEnv, type WebEnv } from './env';
import { createHttp } from './http';
import { createJamApi } from './jam';
import { log } from './log';
import { parseRooms, parseServerInfo, parseToken } from './parse';
import { createWebPresence } from './presence';
import { createWebSession } from './session';
import { createSettingsStore } from './settings';
import { noSubscription, UNSUPPORTED_MESSAGE, unsupported } from './unsupported';

const logger = log('api');

/** The web watches, listens, publishes a camera and uses the Jam; nothing else. */
export const WEB_CAPABILITIES: ClientCapabilities = {
  screenShare: false,
  processAudio: false,
  camera: true,
  popout: false,
  pip: false,
  nativeVideoPip: true,
  tray: false,
  shortcut: false,
  updates: false,
  jamDownload: false,
  serverChoice: false,
  keyLogin: false,
};

export const WEB_UPDATE_REASON = 'A versão web atualiza sozinha a cada publicação.';

const INACTIVE_STREAMING: StreamingState = {
  active: false,
  room: null,
  sourceName: null,
  quality: null,
};
const NO_POPOUT: PopoutState = { open: false, target: null };
const NO_UPDATES: UpdateStatus = { state: 'unsupported', reason: WEB_UPDATE_REASON };
const NO_PROCESS_AUDIO: ProcessAudioSupport = { supported: false, reason: UNSUPPORTED_MESSAGE };

export function createWebApi(env: WebEnv = browserEnv()): ConcordApi {
  const { origin, host } = env.location;
  const http = createHttp({
    host,
    fetchImpl: env.fetchImpl,
    // Any 401 outside the boot check: the cookie is gone, the UI goes back to the login.
    onUnauthorized: () => session.expire(),
  });
  const session = createWebSession({ http, location: env.location, history: env.history });
  const settings = createSettingsStore({ serverUrl: origin, storage: env.storage });
  const jam = createJamApi(http);
  const presence = createWebPresence({
    host,
    createEventSource: env.createEventSource,
    visibility: env.visibility,
    onRefused: () => void session.revalidate(),
  });

  /** The presence stream exists exactly while someone is logged in. */
  function followSession(current: Session): void {
    if (current.user) presence.connect();
    else presence.disconnect('no_session');
  }
  session.onChange(followSession);

  return {
    platform: env.platform,
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
    client: 'web',
    capabilities: WEB_CAPABILITIES,
    joinPurpose: 'web',

    async getSession() {
      const current = await session.getSession();
      followSession(current);
      return current;
    },
    onSessionChanged: (listener) => session.onChange(listener),
    login: unsupported,
    loginWithDiscord: () => session.loginWithDiscord(),
    logout: () => session.logout(),
    setNickname: (nickname) => session.setNickname(nickname),

    getSettings: async () => settings.get(),
    updateSettings: async (patch) => settings.update(patch),
    onSettingsChanged: (listener) => settings.onChange((next) => listener(next)),

    getRooms: () => http.request('/api/rooms', parseRooms),
    requestToken(room, purpose = 'web') {
      const body: TokenRequest = { room, purpose };
      return http.request<TokenResponse>('/api/token', parseToken, body);
    },
    getServerInfo: () => http.request('/api/server', parseServerInfo),
    pingServer: () => http.ping(),

    getPresence: async () => presence.getState(),
    onPresenceEvent: (listener) => presence.onEvent(listener),
    onPresenceStatus: (listener) => presence.onStatus(listener),

    onNavigate: noSubscription,
    onStreamToggleRequested: noSubscription,
    onOpenSettings: noSubscription,

    windowKind: 'main',
    hideToTray: () => undefined,
    openExternal: async (url) => {
      env.openWindow(url);
    },
    async setFullscreen(enabled) {
      const fullscreen = env.fullscreen;
      if (!fullscreen) return;
      try {
        if (enabled) {
          if (!fullscreen.isActive()) await fullscreen.request();
        } else if (fullscreen.isActive()) {
          await fullscreen.exit();
        }
      } catch (err) {
        // iPhone Safari: the page cannot go fullscreen (tiles use the video's own control).
        logger.info('fullscreen change refused by the browser', err);
      }
    },
    onFullscreenChanged: (listener) => env.fullscreen?.subscribe(listener) ?? noSubscription(),

    getCaptureSources: async () => [],
    selectCaptureSource: unsupported,
    setStreamingState: unsupported,
    getStreamingState: async () => INACTIVE_STREAMING,
    onStreamingStateChanged: noSubscription,

    openPopout: unsupported,
    closePopout: unsupported,
    getPopoutTarget: async () => null,
    setAlwaysOnTop: unsupported,
    getAlwaysOnTop: async () => false,
    getPopoutState: async () => NO_POPOUT,
    onPopoutStateChanged: noSubscription,
    focusPopout: unsupported,

    startWindowDrag: unsupported,
    endWindowDrag: unsupported,

    openPip: unsupported,
    updatePip: unsupported,
    closePip: unsupported,
    getPipState: async () => ({ open: false }),
    onPipStateChanged: noSubscription,
    getPipTarget: async () => null,
    onPipTarget: noSubscription,
    showPipMenu: unsupported,
    startPipResize: unsupported,
    endPipResize: unsupported,
    setPipFullscreen: unsupported,
    onPipFullscreenChanged: noSubscription,

    getUpdateStatus: async () => NO_UPDATES,
    checkForUpdates: unsupported,
    installUpdate: unsupported,
    onUpdateStatus: noSubscription,

    getProcessAudioSupport: async () => NO_PROCESS_AUDIO,
    startProcessAudio: unsupported,
    stopProcessAudio: unsupported,
    onProcessAudioData: noSubscription,

    getJam: async () => presence.jam.snapshotNow(),
    onJamEvent: (listener) => presence.jam.onEvent(listener),
    searchJam: (query) => jam.search(query),
    // The api already has the song or asks a desktop app for it: nothing to warm up here.
    prefetchJam: async () => undefined,
    getJamRecent: () => jam.recent(),
    addToJam: (room, videoId) => jam.enqueue(room, videoId),
    removeFromJam: (room, itemId) => jam.remove(room, itemId),
    skipJam: (room, itemId) => jam.skip(room, itemId),
    seekJam: (room, itemId, positionMs) => jam.seek(room, itemId, positionMs),
    previousJam: (room, itemId) => jam.previous(room, itemId),
    pauseJam: (room) => jam.pause(room),
    resumeJam: (room) => jam.resume(room),
    getJamUploads: async () => [],
    onJamUploadStatus: noSubscription,
  };
}
