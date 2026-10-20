/**
 * Utility process entry (`utilityProcess.fork`, built to out/main/now-playing-worker.js): reads
 * what the supported music apps play from the Windows media controls (SMTC) and posts plain
 * snapshots to the main process. `@coooookies/windows-smtc-monitor` locks the thread that uses it,
 * which is why it never runs on Electron's main thread.
 *
 * Events trigger a (debounced) fresh read, and a full re-sync runs every few seconds anyway:
 * Windows is known to stop emitting SMTC events after a while. Cover art travels once per
 * `artId`, before the snapshot that references it.
 */
import type { SmtcMediaInfo, SmtcMonitor, SmtcMonitorClass } from '@concord/now-playing';
import { musicAppFromAumid } from '../music-apps';
import { artIdOf, parseMainMessage, type SessionSnapshot, type WorkerMessage } from './protocol';

/** Full re-read of the sessions even without events. */
const SYNC_INTERVAL_MS = 3_000;
/** SMTC fires bursts (media + playback + timeline on every track change). */
const EVENT_DEBOUNCE_MS = 150;
/** Covers already posted; forgetting them only costs a re-send. */
const SENT_ART_LIMIT = 64;

const port = process.parentPort;

function post(message: WorkerMessage): void {
  port.postMessage(message);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `@concord/now-playing` is external (native binary next to it): required lazily and guarded. */
function loadMonitor(): SmtcMonitorClass | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@concord/now-playing') as typeof import('@concord/now-playing');
    return mod.load();
  } catch (err) {
    post({ type: 'log', level: 'warn', message: `@concord/now-playing: ${describe(err)}` });
    return null;
  }
}

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function run(): void {
  const Monitor = loadMonitor();
  if (!Monitor) {
    post({ type: 'unavailable', reason: 'SMTC module not available on this system' });
    return;
  }
  let monitor: SmtcMonitor;
  try {
    monitor = new Monitor();
  } catch (err) {
    post({ type: 'unavailable', reason: `SMTC monitor failed to start: ${describe(err)}` });
    return;
  }

  const sentArt = new Set<string>();
  let failing = false;

  function snapshot(info: SmtcMediaInfo): SessionSnapshot {
    const thumbnail = info.media?.thumbnail;
    let artId: string | null = null;
    // An empty thumbnail means "not published yet": never treat it as a cover.
    if (thumbnail && thumbnail.byteLength > 0) {
      artId = artIdOf(thumbnail);
      if (!sentArt.has(artId)) {
        if (sentArt.size >= SENT_ART_LIMIT) sentArt.clear();
        sentArt.add(artId);
        // A copy: a view would clone its whole backing buffer.
        post({ type: 'art', artId, bytes: new Uint8Array(thumbnail) });
      }
    }
    return {
      sourceAppId: info.sourceAppId,
      title: text(info.media?.title),
      artist: text(info.media?.artist),
      album: text(info.media?.albumTitle),
      playbackStatus: number(info.playback?.playbackStatus),
      positionSec: number(info.timeline?.position),
      durationSec: number(info.timeline?.duration),
      lastUpdatedTime: number(info.lastUpdatedTime),
      artId,
    };
  }

  const sync = (): void => {
    let sessions: SmtcMediaInfo[];
    try {
      sessions = Monitor.getMediaSessions();
      failing = false;
    } catch (err) {
      if (!failing) post({ type: 'log', level: 'warn', message: `sync: ${describe(err)}` });
      failing = true;
      return;
    }
    const snapshots: SessionSnapshot[] = [];
    for (const info of sessions) {
      if (typeof info?.sourceAppId !== 'string') continue;
      if (musicAppFromAumid(info.sourceAppId) === null) continue;
      snapshots.push(snapshot(info));
    }
    post({ type: 'sessions', sessions: snapshots });
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  // Only music apps' events trigger a read: browsers fire timeline events every second.
  const schedule = (sourceAppId: unknown): void => {
    if (pending) return;
    if (typeof sourceAppId !== 'string' || musicAppFromAumid(sourceAppId) === null) return;
    pending = setTimeout(() => {
      pending = null;
      sync();
    }, EVENT_DEBOUNCE_MS);
  };
  monitor.on('session-added', schedule);
  monitor.on('session-removed', schedule);
  monitor.on('session-media-changed', schedule);
  monitor.on('session-playback-changed', schedule);
  monitor.on('session-timeline-changed', schedule);

  port.on('message', (event) => {
    const message = parseMainMessage(event.data);
    if (message?.type === 'forget-art') sentArt.delete(message.artId);
  });

  sync();
  setInterval(sync, SYNC_INTERVAL_MS);
  post({ type: 'log', level: 'info', message: 'SMTC monitor started' });
}

run();
