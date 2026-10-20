/**
 * What Windows apps are playing (System Media Transport Controls), through
 * `@coooookies/windows-smtc-monitor`. Types are declared here (structurally identical to the
 * package's) so the app type-checks even where the optional dependency is not installed.
 */

/** `PlaybackInfo.playbackStatus` values. */
export declare const PLAYBACK_STATUS: Readonly<{
  CLOSED: 0;
  OPENED: 1;
  CHANGING: 2;
  STOPPED: 3;
  PLAYING: 4;
  PAUSED: 5;
}>;

export interface SmtcMediaProps {
  title: string;
  artist: string;
  albumTitle: string;
  albumArtist: string;
  genres: string[];
  albumTrackCount: number;
  trackNumber: number;
  /** Cover art as published by the app (PNG, JPEG or BMP); absent or empty when none yet. */
  thumbnail?: Buffer | null;
}

export interface SmtcPlaybackInfo {
  /** See `PLAYBACK_STATUS`. */
  playbackStatus: number;
  playbackType: number;
}

export interface SmtcTimelineProps {
  /** Seconds. */
  position: number;
  /** Seconds. */
  duration: number;
}

export interface SmtcMediaInfo {
  /** AUMID of the app (`SpotifyAB.SpotifyMusic_…!Spotify`) or its executable (`Spotify.exe`). */
  sourceAppId: string;
  media: SmtcMediaProps;
  playback: SmtcPlaybackInfo;
  timeline: SmtcTimelineProps;
  /** When the timeline was last updated (Unix epoch, milliseconds). */
  lastUpdatedTime: number;
}

export interface SmtcMonitor {
  on(event: 'session-added', listener: (sourceAppId: string, media: SmtcMediaInfo) => void): this;
  on(event: 'session-removed', listener: (sourceAppId: string) => void): this;
  on(
    event: 'session-media-changed',
    listener: (sourceAppId: string, mediaProps: SmtcMediaProps) => void,
  ): this;
  on(
    event: 'session-playback-changed',
    listener: (sourceAppId: string, playbackInfo: SmtcPlaybackInfo) => void,
  ): this;
  on(
    event: 'session-timeline-changed',
    listener: (sourceAppId: string, timelineProps: SmtcTimelineProps) => void,
  ): this;
  on(event: 'current-session-changed', listener: (sourceAppId: string) => void): this;
  readonly sessions: SmtcMediaInfo[];
  destroy(): void;
}

export interface SmtcMonitorClass {
  new (): SmtcMonitor;
  /** Fresh read of every media session (Windows sometimes stops emitting events). */
  getMediaSessions(): SmtcMediaInfo[];
  getCurrentMediaSession(): SmtcMediaInfo | null;
  getMediaSessionByAppId(sourceAppId: string): SmtcMediaInfo | null;
}

/** Overrides used by tests; production callers pass nothing. */
export interface LoadOptions {
  platform?: string;
  /** Replaces `require('@coooookies/windows-smtc-monitor')`. */
  requireMonitor?: () => unknown;
}

/**
 * The `SMTCMonitor` class, or null off Windows and when the module or its binary is missing.
 * It locks the calling thread: use it in a utility process (or worker), never in Electron's main.
 */
export function load(options?: LoadOptions): SmtcMonitorClass | null;
