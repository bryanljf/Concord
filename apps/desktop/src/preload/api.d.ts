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
  ServerInfoResponse,
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
  /** Chimes when someone starts or stops watching your live or a live you watch. */
  viewerSounds: boolean;
  /** Chimes when someone (or you) enters or leaves the room you are in. */
  roomSounds: boolean;
  /** `MediaDeviceInfo.deviceId` used to play streams, or null for the system default. */
  audioOutputDeviceId: string | null;
  /** Whether the "closing hides to the tray" notice was already shown once. */
  trayNoticeShown: boolean;
  /** `MediaDeviceInfo.deviceId` of the webcam, or null for the system default. */
  cameraDeviceId: string | null;
  /** Cameras' picture-in-picture stays above everything, fullscreen games included. */
  pipAlwaysOnTop: boolean;
  /** How the cameras are stacked in the picture-in-picture window. */
  pipLayout: PipLayout;
  /** Width of each camera in the picture-in-picture window (main clamps it to the screen). */
  pipTileWidth: number;
  /** Top-left corner of the picture-in-picture window; null = top-right corner of the screen. */
  pipPosition: { x: number; y: number } | null;
  /** Chime when someone in your room starts broadcasting music. */
  musicSounds: boolean;
  /** The rooms sidebar is reduced to a narrow column of room icons. */
  sidebarCollapsed: boolean;
}

export type PipLayout = 'vertical' | 'horizontal';

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

/** Whether the pop-out window exists and which live it shows (main renderer stops showing it). */
export interface PopoutState {
  open: boolean;
  target: PopoutTarget | null;
}

/** Cameras shown in the picture-in-picture window, in the order they were watched. */
export interface PipTarget {
  room: RoomId;
  /** Participants whose CAMERA is shown (not stream keys). */
  participantIds: string[];
}

export interface PipState {
  open: boolean;
}

/** Corner of the picture-in-picture window grabbed to resize it. */
export type PipResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

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

/** What a process audio capture records. */
export type ProcessAudioTarget =
  /** A desktopCapturer window/screen id (the screen share's audio). */
  | { kind: 'source'; sourceId: string }
  /** A music app's whole process tree (the separate music track). */
  | { kind: 'app'; app: MusicAppId };

export interface ProcessAudioCapture {
  /** Tags this capture's PCM chunks and stops it. */
  captureId: string;
  format: ProcessAudioFormat;
}

// --- Music apps ----------------------------------------------------------------------

/** Apps whose music can be broadcast (Spotify for now). */
export type MusicAppId = 'spotify';

/** What a music app is playing, from the Windows media controls (SMTC). */
export interface NowPlaying {
  app: MusicAppId;
  title: string;
  artist: string;
  album: string;
  state: 'playing' | 'paused' | 'stopped';
  /** An advertisement is playing (no artist/album): the UI shows "Anúncio". */
  ad: boolean;
  /** Position at `at`; extrapolate while playing (`lib/music.ts`). */
  positionMs: number;
  durationMs: number;
  /** `Date.now()` when `positionMs` was true. */
  at: number;
  /** Hash of the cover art (`getMusicArt`); null when the app published none. */
  artId: string | null;
}

export interface MusicAppStatus {
  app: MusicAppId;
  /** The app's process is running. */
  running: boolean;
  /** Null while it has no media session (not played yet, or stopped for a while). */
  nowPlaying: NowPlaying | null;
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
  /** `popout` / `pip` yield hidden, subscribe-only identities for the pop-out and PiP windows. */
  requestToken(room: RoomId, purpose?: TokenPurpose): Promise<TokenResponse>;
  /** Instance name and region of the server (`GET /api/server`). */
  getServerInfo(): Promise<ServerInfoResponse>;
  /** Round trip to the server in milliseconds; rejects when it does not answer. */
  pingServer(): Promise<number>;

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
  windowKind: 'main' | 'popout' | 'pip';
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
  /** Pins the pop-out window above other windows. */
  setAlwaysOnTop(enabled: boolean): Promise<void>;
  /** Whether the pop-out is pinned (so a reopened pop-out shows the right state). */
  getAlwaysOnTop(): Promise<boolean>;
  getPopoutState(): Promise<PopoutState>;
  /** Fired when the pop-out opens, closes or changes live. */
  onPopoutStateChanged(listener: (state: PopoutState) => void): () => void;
  /** Brings the pop-out window to the front ("Mostrar janela"). */
  focusPopout(): Promise<void>;

  // --- Frameless windows (pop-out, picture-in-picture) ------------------------------
  /**
   * Starts moving the calling window with the mouse (main follows the cursor) until
   * `endWindowDrag()`; replaces `-webkit-app-region: drag`, which swallows hover and clicks.
   */
  startWindowDrag(): Promise<void>;
  endWindowDrag(): Promise<void>;

  // --- Cameras' picture-in-picture ----------------------------------------------------
  /** Main window: opens the picture-in-picture (or brings it to the front) with these cameras. */
  openPip(target: PipTarget): Promise<void>;
  /** Main window: new camera list while open (no-op when closed; an empty list closes it). */
  updatePip(target: PipTarget): Promise<void>;
  closePip(): Promise<void>;
  getPipState(): Promise<PipState>;
  onPipStateChanged(listener: (state: PipState) => void): () => void;
  /** Picture-in-picture renderer: the cameras to show (null elsewhere). */
  getPipTarget(): Promise<PipTarget | null>;
  onPipTarget(listener: (target: PipTarget) => void): () => void;
  /** Picture-in-picture renderer: native menu (always on top, fullscreen, layout, close…). */
  showPipMenu(): Promise<void>;
  /** Picture-in-picture renderer: resize from a corner until `endPipResize()` (keeps the ratio). */
  startPipResize(corner: PipResizeCorner): Promise<void>;
  endPipResize(): Promise<void>;
  /** Picture-in-picture renderer: cover the whole screen, or go back to the previous size. */
  setPipFullscreen(enabled: boolean): Promise<void>;
  onPipFullscreenChanged(listener: (enabled: boolean) => void): () => void;

  // --- Updates (Phase 6) ----------------------------------------------------------
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  /** Quits and installs a `ready` update. */
  installUpdate(): Promise<void>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;

  // --- Process audio (Phase 3b) ---------------------------------------------------
  getProcessAudioSupport(): Promise<ProcessAudioSupport>;
  /**
   * Starts one capture; several can run at once (the screen share's and the music's), each
   * owned by the window that started it. Window source: only that window's process tree. Screen
   * source: everything except Discord's process tree. Music app: that app's process tree
   * (rejects with code `app_not_running` when it is closed). PCM arrives through
   * `onProcessAudioData` tagged with the returned `captureId`, as interleaved float32 frames.
   */
  startProcessAudio(target: ProcessAudioTarget): Promise<ProcessAudioCapture>;
  stopProcessAudio(captureId: string): Promise<void>;
  onProcessAudioData(listener: (captureId: string, chunk: Float32Array) => void): () => void;
  /** A capture ended on its own: the captured app was closed (main stopped it already). */
  onProcessAudioEnded(listener: (captureId: string, reason: 'app_closed') => void): () => void;

  // --- Music apps (what they play) -------------------------------------------------
  /** Whether the app runs and what it plays (Windows media controls), right now. */
  getMusicAppStatus(app: MusicAppId): Promise<MusicAppStatus>;
  /** Pushed whenever a supported music app starts, closes or changes what it plays. */
  onMusicAppStatus(listener: (status: MusicAppStatus) => void): () => void;
  /** Cover art for `NowPlaying.artId` as a `data:image/jpeg` URL (≤ 160 px); null if unknown. */
  getMusicArt(artId: string): Promise<string | null>;
}

declare global {
  interface Window {
    concord: ConcordApi;
  }
}
