import { readFile } from 'node:fs/promises';
import {
  JAM_HISTORY_MAX,
  YOUTUBE_VIDEO_ID_PATTERN,
  type JamItem,
  type JamNowPlaying,
  type JamState,
  type JamTrack,
  type RoomId,
} from '@concord/shared';
import { moveAsideCorrupt, writeFileAtomic } from '../atomic-file';
import type { Logger } from '../logger';
import type { PendingUpload, PersistedJam } from './store';

export class JamStateFileError extends Error {
  override name = 'JamStateFileError';
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A server clock time (or duration): a finite number, 0 or more. */
export const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A song's description as we saved it (state file, cache infos); undefined when malformed. */
export function parseTrack(value: unknown): JamTrack | undefined {
  if (!isRecord(value)) return undefined;
  const { videoId, title, artists, album, durationMs, artworkUrl } = value;
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return undefined;
  if (!isText(title) || typeof artists !== 'string' || !isTime(durationMs)) return undefined;
  if (album !== null && typeof album !== 'string') return undefined;
  if (artworkUrl !== null && typeof artworkUrl !== 'string') return undefined;
  return { videoId, title, artists, album, durationMs, artworkUrl };
}

function parseItem(value: unknown): JamItem | undefined {
  if (!isRecord(value)) return undefined;
  const track = parseTrack(value.track);
  const { id, requestedBy, addedAt, status } = value;
  if (!track || !isText(id) || !isText(requestedBy) || !isTime(addedAt)) return undefined;
  if (status !== 'ready' && status !== 'downloading') return undefined;
  return { id, track, requestedBy, addedAt, status };
}

/** The valid items of a list (anything else: none). */
function parseItems(value: unknown): JamItem[] {
  return (Array.isArray(value) ? value : [])
    .map(parseItem)
    .filter((item): item is JamItem => item !== undefined);
}

function parseNowPlaying(value: unknown): JamNowPlaying | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const item = parseItem(value.item);
  const { positionMs, at, paused, pausedBy } = value;
  if (!item || item.status !== 'ready' || !isTime(positionMs) || !isTime(at)) return undefined;
  if (typeof paused !== 'boolean' || (pausedBy !== null && !isText(pausedBy))) return undefined;
  return { item, positionMs, at, paused, pausedBy: paused ? pausedBy : null };
}

/**
 * An upload as saved. A delegated one (some app was asked to download it) comes back without its
 * fetcher: the sweep asks someone again, still counting the attempts and skipping who was asked.
 */
function parseUpload(value: unknown, rooms: ReadonlySet<RoomId>): PendingUpload | undefined {
  if (!isRecord(value)) return undefined;
  const { videoId, itemId, room, requestedBy, deadline, assignments, tried } = value;
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return undefined;
  if (!isText(itemId) || typeof room !== 'string' || !rooms.has(room)) return undefined;
  if (!isText(requestedBy) || !isTime(deadline)) return undefined;
  return {
    videoId,
    itemId,
    room,
    requestedBy,
    deadline,
    receiving: false,
    fetcher: null,
    assignments: isTime(assignments) && Number.isInteger(assignments) ? assignments : 0,
    tried: Array.isArray(tried) ? tried.filter(isText) : [],
  };
}

/**
 * Parses `JAM_STATE_FILE`. Entries that are malformed, or rooms no longer configured, are
 * dropped rather than failing the load; only an unreadable file throws JamStateFileError.
 */
export function parseJamStateFile(json: string, rooms: readonly RoomId[]): PersistedJam {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new JamStateFileError(`jam state file is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.rooms)) {
    throw new JamStateFileError('jam state file must be a version 1 object with a "rooms" array');
  }
  const known = new Set(rooms);
  const states: JamState[] = [];
  const itemIds = new Set<string>();
  for (const value of data.rooms) {
    if (!isRecord(value) || typeof value.room !== 'string' || !known.has(value.room)) continue;
    if (states.some((state) => state.room === value.room)) continue;
    const current = parseNowPlaying(value.current);
    const queue = parseItems(value.queue);
    const state: JamState & { history: JamItem[] } = {
      room: value.room,
      current: current ?? null,
      queue: [],
      history: [],
    };
    for (const item of [...(state.current ? [state.current.item] : []), ...queue]) {
      if (itemIds.has(item.id)) continue;
      itemIds.add(item.id);
      if (item !== state.current?.item) state.queue.push(item);
    }
    // Only songs that played (so ready), most recent first, within the limit.
    for (const item of parseItems(value.history)) {
      if (item.status !== 'ready' || itemIds.has(item.id)) continue;
      if (state.history.length >= JAM_HISTORY_MAX) break;
      itemIds.add(item.id);
      state.history.push(item);
    }
    states.push(state);
  }
  const uploads = new Map<string, PendingUpload>();
  for (const value of Array.isArray(data.uploads) ? data.uploads : []) {
    const upload = parseUpload(value, known);
    if (upload && !uploads.has(upload.videoId)) uploads.set(upload.videoId, upload);
  }
  return { version: 1, rooms: states, uploads: [...uploads.values()] };
}

/**
 * Reads the persisted jam. A missing file is an empty jam; a corrupt one is logged, moved aside
 * to `<path>.corrupt-<timestamp>` (only the latest such copy is kept) and the jam starts empty.
 */
export async function readJamStateFile(
  path: string,
  rooms: readonly RoomId[],
  log: Logger,
  now: () => number = Date.now,
): Promise<PersistedJam | undefined> {
  let json: string;
  try {
    json = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return parseJamStateFile(json, rooms);
  } catch (err) {
    try {
      const backup = await moveAsideCorrupt(path, now());
      log.error({ err, path, backup }, 'jam state file is corrupt, moved aside; starting empty');
    } catch (renameErr) {
      log.error({ err, renameErr, path }, 'jam state file is corrupt; starting empty');
    }
    return undefined;
  }
}

export interface JamStateWriterOptions {
  path: string;
  /** The state to write, read when the write happens (so it is always the latest). */
  read: () => PersistedJam;
  log: Logger;
  debounceMs?: number;
}

/** Debounced, serialized and atomic writes of the jam state. */
export class JamStateWriter {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;

  constructor(private readonly options: JamStateWriterOptions) {
    this.debounceMs = options.debounceMs ?? 500;
  }

  /** Writes soon, coalescing the changes made meanwhile. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write();
    }, this.debounceMs);
  }

  /** Writes now (pending changes included) and resolves once it is on disk. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.write();
  }

  private write(): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        const data = `${JSON.stringify(this.options.read(), null, 2)}\n`;
        await writeFileAtomic(this.options.path, data);
      } catch (err) {
        this.options.log.error({ err, path: this.options.path }, 'could not save the jam state');
      }
    });
    this.chain = run;
    return run;
  }
}
