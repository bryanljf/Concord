/**
 * Contract between the Electron main process and the renderer, exposed as `window.telao`
 * by `src/preload/index.ts`. The main process owns: settings, the encrypted access key,
 * every HTTP call to telao-api, the presence SSE connection, tray and notifications.
 * The renderer only talks to LiveKit directly (media), using tokens obtained here.
 */
import type {
  PresenceEvent,
  PresenceSnapshot,
  QualityPresetId,
  RoomId,
  TokenResponse,
  UserInfo,
} from '@telao/shared';

/** Persisted preferences (JSON file in `app.getPath('userData')`). */
export interface Settings {
  /** Base URL of telao-api, e.g. "http://127.0.0.1:3000" or "https://telao.duckdns.org". */
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

export interface TelaoApi {
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
  logout(): Promise<void>;

  // --- Settings ---------------------------------------------------------------
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Fired after any change, including the tray checkboxes, so the UI never goes stale. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void;

  // --- telao-api calls (main adds the Authorization header) ------------------
  getRooms(): Promise<RoomId[]>;
  requestToken(room: RoomId): Promise<TokenResponse>;

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
  hideToTray(): void;
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    telao: TelaoApi;
  }
}
