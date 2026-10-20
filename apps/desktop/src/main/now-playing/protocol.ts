/**
 * Messages between the main process (`now-playing/service.ts`) and the utility process that reads
 * the Windows media sessions (`now-playing/worker.ts`). Plain, structured-clone friendly data;
 * no Electron imports, since both sides bundle this file.
 */
import { createHash } from 'node:crypto';

/** One media session of a supported music app, flattened for `postMessage`. */
export interface SessionSnapshot {
  /** SMTC `sourceAppId` (AUMID or executable name). */
  sourceAppId: string;
  title: string;
  artist: string;
  /** `albumTitle`. */
  album: string;
  /** SMTC playback status: 0 closed, 1 opened, 2 changing, 3 stopped, 4 playing, 5 paused. */
  playbackStatus: number;
  /** Seconds, as SMTC reports them. */
  positionSec: number;
  durationSec: number;
  /** When the position was true (Unix epoch, ms); 0 when unknown. */
  lastUpdatedTime: number;
  /** `artIdOf(thumbnail)`; null while the app published no cover (it often arrives late). */
  artId: string | null;
}

export type WorkerMessage =
  /** Every session of a supported music app, after an SMTC event or the periodic re-sync. */
  | { type: 'sessions'; sessions: SessionSnapshot[] }
  /** Cover art bytes, sent once per `artId` (always before the `sessions` that reference it). */
  | { type: 'art'; artId: string; bytes: Uint8Array }
  /** The SMTC module cannot run here (missing binary, old Windows): do not restart the worker. */
  | { type: 'unavailable'; reason: string }
  | { type: 'log'; level: 'info' | 'warn'; message: string };

/** Main → worker: "I do not have this cover, send it again". */
export type MainMessage = { type: 'forget-art'; artId: string };

/** `NowPlaying.artId`: first 16 hex digits of the cover's SHA-1. */
export const ART_ID_PATTERN = /^[0-9a-f]{16}$/;

export function artIdOf(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TEXT_MAX = 500;
const text = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, TEXT_MAX) : '';
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function parseSession(raw: unknown): SessionSnapshot | null {
  if (!isRecord(raw) || typeof raw.sourceAppId !== 'string') return null;
  const artId = typeof raw.artId === 'string' && ART_ID_PATTERN.test(raw.artId) ? raw.artId : null;
  return {
    sourceAppId: raw.sourceAppId.slice(0, TEXT_MAX),
    title: text(raw.title),
    artist: text(raw.artist),
    album: text(raw.album),
    playbackStatus: Number.isInteger(raw.playbackStatus) ? (raw.playbackStatus as number) : 0,
    positionSec: finite(raw.positionSec),
    durationSec: finite(raw.durationSec),
    lastUpdatedTime: finite(raw.lastUpdatedTime),
    artId,
  };
}

/** Defensive decode of what the worker posted; null for anything unexpected. */
export function parseWorkerMessage(raw: unknown): WorkerMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'sessions': {
      if (!Array.isArray(raw.sessions)) return null;
      const sessions: SessionSnapshot[] = [];
      for (const item of raw.sessions) {
        const session = parseSession(item);
        if (session) sessions.push(session);
      }
      return { type: 'sessions', sessions };
    }
    case 'art':
      if (typeof raw.artId !== 'string' || !ART_ID_PATTERN.test(raw.artId)) return null;
      if (!(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength === 0) return null;
      return { type: 'art', artId: raw.artId, bytes: raw.bytes };
    case 'unavailable':
      return { type: 'unavailable', reason: text(raw.reason) };
    case 'log':
      return {
        type: 'log',
        level: raw.level === 'warn' ? 'warn' : 'info',
        message: text(raw.message),
      };
    default:
      return null;
  }
}

export function parseMainMessage(raw: unknown): MainMessage | null {
  if (!isRecord(raw) || raw.type !== 'forget-art') return null;
  if (typeof raw.artId !== 'string' || !ART_ID_PATTERN.test(raw.artId)) return null;
  return { type: 'forget-art', artId: raw.artId };
}
