/**
 * Contract between the Electron main process and the renderer, exposed as `window.concord`
 * by `src/preload/index.ts`. The main process owns: settings, the encrypted access key,
 * every HTTP call to concord-api, the presence SSE connection, tray and notifications.
 * The renderer only talks to LiveKit directly (media), using tokens obtained here.
 */
import type {
  PresenceEvent,
  PresenceSnapshot,
  QualityPresetId,
  RoomId,
  TokenPurpose,
  TokenResponse,
  UserInfo,
} from '@concord/shared';

/** Persisted preferences (JSON file in `app.getPath('userData')`). */
export interface Settings {
  /** Base URL of concord-api, e.g. "http://127.0.0.1:3000" or "https://concord.duckdns.org". */
  serverUrl: string;
  launchAtLogin: boolean;
  /** Keep the presence connection only while Discord is running ("Abrir junto com o Discord"). */
  followDiscord: boolean;
  /** Electron accelerator that starts/stops streaming (default "CommandOrControl+Shift+L"). */
  shortcut: string;
  defaultQuality: QualityPresetId;
  codec: 'h264' | 'vp9' | 'av1';
  /** Rooms and users whose "ao vivo" notifications are silenced. */
  mutedRooms: RoomId[];
  mutedUsers: string[];
  /** `MediaDeviceInfo.deviceId` used to play streams, or null for the system default. */
  audioOutputDeviceId: string | null;
  /** Whether the "closing hides to the tray" notice was already shown once. */
  trayNoticeShown: boolean;
}

export interface Session {
  serverUrl: string;
  /** Null until onboarding completes (no key stored, or the server rejected it). */
  user: UserInfo | null;
}

export type PresenceConnectionStatus =
  | { state: 'idle'; reason: 'no_session' | 'discord_closed' }
  | { state: 'connecting'; attempt: number }
  | { state: 'connected' }
  | { state: 'error'; message: string; retryInMs: number };

export interface PresenceState {
  status: PresenceConnectionStatus;
  snapshot: PresenceSnapshot;
}

export interface NavigateTarget {
  room: RoomId;
  /** When set, the UI should enter the room and focus this participant's stream. */
  participantId?: string;
}

// --- Capture / streaming (Phase 3) ----------------------------------------------

export interface CaptureSource {
  /** `desktopCapturer` id: `window:<hwnd>:0` or `screen:<n>:0`. */
  id: string;
  name: string;
  kind: 'window' | 'screen';
  /** PNG data URL, refreshed on every `getCaptureSources()` call. */
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface CaptureSelection {
  sourceId: string;
  /** Add Electron's system loopback audio (whole system, including the Discord call). */
  systemAudio: boolean;
}

/** What this instance is currently publishing; owned by the renderer, mirrored by main. */
export interface StreamingState {
  active: boolean;
  room: RoomId | null;
  sourceName: string | null;
  quality: QualityPresetId | null;
}

export interface PopoutTarget {
  room: RoomId;
  participantId: string;
}

// --- Updates (Phase 6) -------------------------------------------------------------

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up_to_date'; version: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  /** Development build or a platform without an updater. */
  | { state: 'unsupported'; reason: string };

// --- Process audio (Phase 3b) ---------------------------------------------------------

export interface ProcessAudioSupport {
  supported: boolean;
  /** pt-BR explanation when unsupported (old Windows, missing native module, ...). */
  reason: string | null;
}

export interface ProcessAudioFormat {
  sampleRate: number;
  channels: number;
}

export interface ConcordApi {
  platform: string;
  /** App version from package.json. */
  version: string;

  // --- Session / onboarding -------------------------------------------------
  getSession(): Promise<Session>;
  /** Fired after login/logout, and when a stored key is rejected during background revalidation. */
  onSessionChanged(listener: (session: Session) => void): () => void;
  /**
   * Validates `key` against `GET /api/me` on `serverUrl`, stores both (key encrypted with
   * `safeStorage`) and returns the user. Rejects with an Error whose `message` is pt-BR and
   * safe to show in the UI.
   */
  login(serverUrl: string, key: string): Promise<UserInfo>;
  /** Opens the official Discord OAuth2 login in a hardened Electron window. */
  loginWithDiscord(serverUrl: string): Promise<UserInfo>;
  logout(): Promise<void>;
  /**
   * Sets the display name shown to everyone (`PUT /api/me/nickname`); null or '' goes back to
   * the Discord name. Resolves with the updated user and also fires `onSessionChanged`.
   */
  setNickname(nickname: string | null): Promise<UserInfo>;

  // --- Settings ---------------------------------------------------------------
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Fired after any change, including the tray checkboxes, so the UI never goes stale. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void;

  // --- concord-api calls (main adds the Authorization header) ------------------
  getRooms(): Promise<RoomId[]>;
  /** `purpose: 'popout'` yields a hidden, subscribe-only identity for the pop-out window. */
  requestToken(room: RoomId, purpose?: TokenPurpose): Promise<TokenResponse>;

  // --- Presence (SSE lives in main) --------------------------------------------
  getPresence(): Promise<PresenceState>;
  onPresenceEvent(listener: (event: PresenceEvent) => void): () => void;
  onPresenceStatus(listener: (status: PresenceConnectionStatus) => void): () => void;

  // --- Requests coming from main (tray, notifications, shortcut) --------------
  onNavigate(listener: (target: NavigateTarget) => void): () => void;
  /** Tray item "Transmitir…" or the global shortcut; streaming itself arrives in Phase 3. */
  onStreamToggleRequested(listener: () => void): () => void;
  /** Tray item "Configurações": the UI should open its settings view. */
  onOpenSettings(listener: () => void): () => void;

  // --- Window ------------------------------------------------------------------
  /** Which BrowserWindow this renderer lives in. */
  windowKind: 'main' | 'popout';
  hideToTray(): void;
  openExternal(url: string): Promise<void>;
  setFullscreen(enabled: boolean): Promise<void>;
  onFullscreenChanged(listener: (enabled: boolean) => void): () => void;

  // --- Capture / streaming (Phase 3) ---------------------------------------------
  getCaptureSources(): Promise<CaptureSource[]>;
  /**
   * Must be called right before `navigator.mediaDevices.getDisplayMedia()`: main answers the
   * next display-media request with this source (and loopback audio when `systemAudio`).
   */
  selectCaptureSource(selection: CaptureSelection): Promise<void>;
  /** The renderer reports what it publishes; main updates tray/tooltip and pop-outs. */
  setStreamingState(state: StreamingState): Promise<void>;
  getStreamingState(): Promise<StreamingState>;
  onStreamingStateChanged(listener: (state: StreamingState) => void): () => void;

  // --- Pop-out window -------------------------------------------------------------
  /** Opens (or re-targets) the frameless pop-out window showing one participant's stream. */
  openPopout(target: PopoutTarget): Promise<void>;
  closePopout(): Promise<void>;
  /** In the pop-out renderer: what to show. Null in the main window. */
  getPopoutTarget(): Promise<PopoutTarget | null>;
  setAlwaysOnTop(enabled: boolean): Promise<void>;

  // --- Updates (Phase 6) ----------------------------------------------------------
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  /** Quits and installs a `ready` update. */
  installUpdate(): Promise<void>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;

  // --- Process audio (Phase 3b) ---------------------------------------------------
  getProcessAudioSupport(): Promise<ProcessAudioSupport>;
  /**
   * Window source: captures only that window's process tree. Screen source: captures
   * everything except Discord's process tree. PCM arrives through `onProcessAudioData` as
   * interleaved float32 frames in the returned format.
   */
  startProcessAudio(sourceId: string): Promise<ProcessAudioFormat>;
  stopProcessAudio(): Promise<void>;
  onProcessAudioData(listener: (chunk: Float32Array) => void): () => void;
}

declare global {
  interface Window {
    concord: ConcordApi;
  }
}
