/**
 * Contract between the Electron main process and the renderer, exposed as `window.concord`
 * by `src/preload/index.ts`. The main process owns: settings, the encrypted access key,
 * every HTTP call to concord-api, the presence SSE connection, tray and notifications.
 * The renderer only talks to LiveKit directly (media), using tokens obtained here.
 *
 * The web client (`src/web`) implements the same contract in the browser (`fetch`, `EventSource`,
 * `localStorage`): `client` says which one this is and `capabilities` what it can do, so the
 * renderer hides what does not exist instead of calling it. A method a client does not support
 * rejects with `{ name: 'UnsupportedError', code: 'unsupported', message }` (pt-BR).
 */
import type {
  JamEvent,
  JamItem,
  JamRecentTrack,
  JamSnapshot,
  JamTrack,
  PresenceEvent,
  PresenceSnapshot,
  RoomId,
  ServerInfoResponse,
  StreamQualityId,
  TokenPurpose,
  TokenResponse,
  UserInfo,
} from '@concord/shared';

export type VideoEncoderPreference = 'cpu' | 'gpu';

/** Persisted preferences (JSON file in `app.getPath('userData')`). */
export interface Settings {
  /** Base URL of concord-api, e.g. "http://127.0.0.1:3000" or "https://concord.duckdns.org". */
  serverUrl: string;
  launchAtLogin: boolean;
  /** Keep the presence connection only while Discord is running ("Abrir junto com o Discord"). */
  followDiscord: boolean;
  /** Electron accelerator that starts/stops streaming (default "CommandOrControl+Shift+L"). */
  shortcut: string;
  /** Resolution × frame rate the picker starts with, e.g. "1080p30". */
  defaultQuality: StreamQualityId;
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
  /** Chime when a Jam starts in your room (someone else's song). */
  musicSounds: boolean;
  /** The rooms sidebar is reduced to a narrow column of room icons. */
  sidebarCollapsed: boolean;
  /**
   * Who encodes your lives and webcam: `cpu` (OpenH264, as always) or `gpu` (the graphics card's
   * H.264 encoder when there is one, else the CPU anyway). Applies to the next publish.
   */
  videoEncoder: VideoEncoderPreference;
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

/**
 * The part of a captured window that is the app itself, without the Windows title bar and borders
 * (window capture delivers the whole window frame). Physical pixels of the captured image.
 */
export interface CaptureCrop {
  /** Size of the whole captured window image the rectangle below refers to. */
  frameWidth: number;
  frameHeight: number;
  /** The client area inside that image. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What this instance is currently publishing; owned by the renderer, mirrored by main. */
export interface StreamingState {
  active: boolean;
  room: RoomId | null;
  sourceName: string | null;
  quality: StreamQualityId | null;
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

/** What a process audio capture records: a desktopCapturer window/screen (the live's audio). */
export interface ProcessAudioTarget {
  kind: 'source';
  sourceId: string;
}

export interface ProcessAudioCapture {
  /** Tags this capture's PCM chunks and stops it. */
  captureId: string;
  format: ProcessAudioFormat;
}

// --- Jam (YouTube Music queue per room) -------------------------------------------------

/** This app's part in a jam song it added: downloading it from YouTube and sending it. */
export interface JamUploadStatus {
  itemId: string;
  room: RoomId;
  /** Song title, for toasts. */
  title: string;
  /**
   * `preparing`: fetching or updating the downloader (yt-dlp) first; `downloading`: from
   * YouTube; `uploading`: to the server; `done`: the server has it; `error`: gave up (main
   * already removed the song from the queue).
   */
  state: 'preparing' | 'downloading' | 'uploading' | 'done' | 'error';
  /** pt-BR and safe to show; set with `error`, null otherwise. */
  message: string | null;
}

export type ClientKind = 'desktop' | 'web';

/**
 * What this client can do. The desktop app has everything (`jamDownload` only on Windows); the
 * web client watches, listens, publishes a camera and uses the Jam, nothing that needs Electron
 * or Windows.
 */
export interface ClientCapabilities {
  /** Publishing a window or screen: capture sources, streaming state, quality settings. */
  screenShare: boolean;
  /** Per-process audio capture (Windows addon). */
  processAudio: boolean;
  /** Publishing a webcam. */
  camera: boolean;
  /** The frameless pop-out window of one live. */
  popout: boolean;
  /** The cameras' picture-in-picture window (Electron). */
  pip: boolean;
  /** The browser's own video picture-in-picture (`HTMLVideoElement.requestPictureInPicture`). */
  nativeVideoPip: boolean;
  /** Tray icon, hide-to-tray, launch at login, "follow Discord". */
  tray: boolean;
  /** Global keyboard shortcut to transmit/stop. */
  shortcut: boolean;
  /** Auto-updates (on the web, deploying is the update). */
  updates: boolean;
  /** This client runs yt-dlp: it downloads the Jam songs it adds (and those the server asks for). */
  jamDownload: boolean;
  /** The onboarding lets the person type the server URL (web: fixed to its own origin). */
  serverChoice: boolean;
  /** Login with an access key besides Discord. */
  keyLogin: boolean;
}

export interface ConcordApi {
  platform: string;
  /** App version from package.json. */
  version: string;
  /** Which implementation backs this bridge. */
  readonly client: ClientKind;
  readonly capabilities: ClientCapabilities;
  /**
   * Purpose of the token the main window joins rooms with (`requestToken` default): `main` on
   * the desktop, `web` in the browser. The identity LiveKit sees is `identityFor(user.id, joinPurpose)`.
   */
  readonly joinPurpose: 'main' | 'web';

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
  /**
   * `popout` / `pip` yield hidden, subscribe-only identities for the pop-out and PiP windows;
   * omitted = `joinPurpose`.
   */
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
  /**
   * Where the app's own content sits inside a captured window (`window:<hwnd>:0`), so the renderer
   * can crop the title bar and borders away. Null for screens, windows that are gone, and windows
   * with nothing to crop (borderless, fullscreen). Asked again whenever the captured frame size
   * changes. The web client always resolves null.
   */
  getCaptureCrop(sourceId: string): Promise<CaptureCrop | null>;
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
   * Starts one capture, owned by the window that started it. Window source: only that window's
   * process tree. Screen source: everything except Discord's process tree. PCM arrives through
   * `onProcessAudioData` tagged with the returned `captureId`, as interleaved float32 frames.
   */
  startProcessAudio(target: ProcessAudioTarget): Promise<ProcessAudioCapture>;
  stopProcessAudio(captureId: string): Promise<void>;
  onProcessAudioData(listener: (captureId: string, chunk: Float32Array) => void): () => void;

  // --- Jam (YouTube Music queue per room; events ride the presence SSE) ---------------
  /** Every room's jam, as last received (`available: false` until the server says so). */
  getJam(): Promise<JamSnapshot>;
  onJamEvent(listener: (event: JamEvent) => void): () => void;
  /**
   * YouTube Music songs for `query` (`GET /api/jam/search`); rejects with a pt-BR message. Main
   * also starts prefetching the top result (unless the server already has it).
   */
  searchJam(query: string): Promise<JamTrack[]>;
  /**
   * Starts downloading these songs in the background (memory only, a few at most, dropped after
   * a few minutes unless added), so adding one of them is near-instant. Fire and forget: call it
   * when a result is hovered/focused or a pasted link is recognized.
   */
  prefetchJam(videoIds: string[]): Promise<void>;
  /**
   * "Recentes": the songs the server still has (its 3 h cache), most recently played first; adding
   * one is instant. Rejects with a pt-BR message.
   */
  getJamRecent(): Promise<JamRecentTrack[]>;
  /**
   * Adds a song to the room's queue and resolves with the queued item. When the server needs
   * its audio, main downloads it (yt-dlp, anonymous: no cookies, no account) and uploads it in
   * the background, reporting through `onJamUploadStatus`. Rejects with a pt-BR message.
   */
  addToJam(room: RoomId, videoId: string): Promise<JamItem>;
  /** Removes an upcoming song; removing the one playing skips it. */
  removeFromJam(room: RoomId, itemId: string): Promise<void>;
  /** Skips `itemId` only if it is still the one playing. */
  skipJam(room: RoomId, itemId: string): Promise<void>;
  /**
   * Moves the song playing (`itemId`, still current) to `positionMs` for everyone; resolves
   * quietly when it is no longer the one playing. Rejects with a pt-BR message.
   */
  seekJam(room: RoomId, itemId: string, positionMs: number): Promise<void>;
  /**
   * "Música anterior": plays the room's previous song (`JamState.history[0]`) from the start and
   * puts the song playing (`itemId`, null when none) back at the front of the queue; resolves
   * quietly when the song playing changed meanwhile. Rejects with a pt-BR message.
   */
  previousJam(room: RoomId, itemId: string | null): Promise<void>;
  /** Pauses / resumes the room's jam for everyone. */
  pauseJam(room: RoomId): Promise<void>;
  resumeJam(room: RoomId): Promise<void>;
  /** Latest status of each song this app is sending (or sent in the last minutes). */
  getJamUploads(): Promise<JamUploadStatus[]>;
  onJamUploadStatus(listener: (status: JamUploadStatus) => void): () => void;
}

declare global {
  interface Window {
    concord: ConcordApi;
  }
}
