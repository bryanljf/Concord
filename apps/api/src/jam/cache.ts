import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JAM_UPLOAD_TIMEOUT_MS, type JamRecentTrack, type JamTrack } from '@concord/shared';
import { renameWithRetry } from '../atomic-file';
import type { Logger } from '../logger';
import { isTime, parseTrack } from './state-file';

const CACHED_FILE = /^[A-Za-z0-9_-]{11}\.webm$/;
const INFO_FILE = /^[A-Za-z0-9_-]{11}\.json$/;
const TEMP_PREFIX = '.tmp-';

/**
 * What the cache remembers of a song that played, in `<videoId>.json` next to its audio (the bot
 * only ever reads `.webm` files). Written when the song starts playing with its audio stored, or
 * when the audio of a song that started while it streamed gets stored; deleted with its audio.
 */
export interface SongInfo {
  track: JamTrack;
  /** Server clock: when it last started playing (in any room). */
  playedAt: number;
}

/** A use of a song, for its info file. */
export interface SongUse {
  /** It started playing at this server time. */
  playedAt?: number;
  /** `track` has the file's exact duration: it replaces what was remembered. */
  exact?: boolean;
}

function parseSongInfo(value: unknown, videoId: string): SongInfo | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { version, track, playedAt } = value as Record<string, unknown>;
  const parsed = parseTrack(track);
  if (version !== 1 || parsed?.videoId !== videoId || !isTime(playedAt)) return undefined;
  return { track: parsed, playedAt };
}

/** Files the bot (another uid in production) only reads: world-readable, never writable. */
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export interface JamAudioCacheOptions {
  /** Songs unused (not enqueued nor played) for this long are deleted; 0 keeps them. */
  ttlMs?: number;
  /** Temporary upload files untouched for this long are leftovers (default JAM_UPLOAD_TIMEOUT_MS). */
  tempMaxAgeMs?: number;
  now?: () => number;
}

export interface CacheMaintenance {
  /** Songs deleted for being unused longer than the TTL. */
  expired: string[];
  /** Songs deleted, least recently used first, to fit the size limit. */
  evicted: string[];
  /** Leftover temporary upload files deleted. */
  temps: number;
  /** Song infos left without their audio, deleted. */
  orphans: number;
}

interface CachedSong {
  videoId: string;
  size: number;
  usedAt: number;
}

/**
 * The songs' audio, one `<videoId>.webm` per song, in `JAM_CACHE_DIR` (the bot reads the same
 * absolute paths). A song's modification time is its last use (enqueued or played): unused songs
 * expire after the TTL and the least recently used go first when the cache outgrows its limit.
 */
export class JamAudioCache {
  private readonly ttlMs: number;
  private readonly tempMaxAgeMs: number;
  private readonly now: () => number;
  /** Info writes in progress, per song (one at a time). */
  private readonly noting = new Map<string, Promise<void>>();

  constructor(
    /** Absolute directory. */
    readonly dir: string,
    private readonly maxBytes: number,
    private readonly log: Logger,
    options: JamAudioCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 0;
    this.tempMaxAgeMs = options.tempMaxAgeMs ?? JAM_UPLOAD_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Absolute path of a song's audio (`videoId` must match YOUTUBE_VIDEO_ID_PATTERN). */
  fileFor(videoId: string): string {
    return join(this.dir, `${videoId}.webm`);
  }

  /** Absolute path of a song's info, next to its audio. */
  infoFor(videoId: string): string {
    return join(this.dir, `${videoId}.json`);
  }

  /** A fresh temporary path inside the cache, for an upload being received (or an info). */
  tempFile(extension = '.webm'): string {
    return join(this.dir, `${TEMP_PREFIX}${randomUUID()}${extension}`);
  }

  /** Creates the directory when missing (readable by the bot). */
  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
  }

  /** Creates the directory (readable by the bot) and drops temporary files left by a crash. */
  async prepare(): Promise<void> {
    await this.ensureDir();
    await chmod(this.dir, DIR_MODE).catch(() => undefined);
    for (const name of await readdir(this.dir)) {
      if (name.startsWith(TEMP_PREFIX))
        await removeFile(join(this.dir, name)).catch(() => undefined);
    }
  }

  /** Marks a song as just used (enqueued or starting to play). */
  async touch(videoId: string): Promise<void> {
    const now = new Date(this.now());
    await utimes(this.fileFor(videoId), now, now).catch(() => undefined);
  }

  /** Whether the song's audio is here (without counting it as used). */
  async exists(videoId: string): Promise<boolean> {
    try {
      const info = await stat(this.fileFor(videoId));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  /** Whether the song's audio is here; when it is, it counts as just used. */
  async has(videoId: string): Promise<boolean> {
    if (!(await this.exists(videoId))) return false;
    await this.touch(videoId);
    return true;
  }

  /** Lets the bot read a file whatever the umask was (it probes uploads before they are kept). */
  async makeReadable(path: string): Promise<void> {
    await chmod(path, FILE_MODE).catch(() => undefined);
  }

  /** Moves a received upload into place as the song's audio. */
  async commit(tempFile: string, videoId: string): Promise<void> {
    await this.makeReadable(tempFile);
    await renameWithRetry(tempFile, this.fileFor(videoId));
  }

  async discard(path: string): Promise<void> {
    await removeFile(path).catch((err: unknown) =>
      this.log.warn({ err, path }, 'could not delete a jam audio file'),
    );
  }

  /** Deletes a song's audio and its info (after the info writes already asked for). */
  discardSong(videoId: string): Promise<void> {
    return this.inTurn(videoId, async () => {
      await this.discard(this.fileFor(videoId));
      await this.discard(this.infoFor(videoId));
    });
  }

  /**
   * Records a use of a song whose audio is here (nothing happens otherwise) in its info file:
   * created by its first start (`playedAt`, which only moves forward); `exact` replaces the
   * remembered description. One write at a time per song; never rejects (logged).
   */
  noteUse(track: JamTrack, use: SongUse): Promise<void> {
    return this.inTurn(track.videoId, () => this.writeUse(track, use));
  }

  /** Runs `task` after the ones already queued for `videoId`'s info; never rejects (logged). */
  private inTurn(videoId: string, task: () => Promise<void>): Promise<void> {
    const run = (this.noting.get(videoId) ?? Promise.resolve()).then(task).catch((err: unknown) => {
      this.log.warn({ err, videoId }, 'could not save a jam song info');
    });
    this.noting.set(videoId, run);
    void run.then(() => {
      if (this.noting.get(videoId) === run) this.noting.delete(videoId);
    });
    return run;
  }

  /** Resolves once no info write is in progress. */
  async idle(): Promise<void> {
    while (this.noting.size > 0) await Promise.all([...this.noting.values()]);
  }

  /**
   * "Recentes": the songs that played and whose audio is still here, with their description, the
   * last to start playing first. An info without its audio, audio without a (valid) info (never
   * played, or stored before infos existed: its next start writes one) and uploads in progress
   * are left out.
   */
  async recent(): Promise<JamRecentTrack[]> {
    await this.idle();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const found = await Promise.all(
      names
        .filter((name) => CACHED_FILE.test(name))
        .map(async (name): Promise<JamRecentTrack | undefined> => {
          const videoId = name.slice(0, -'.webm'.length);
          if (!(await this.exists(videoId))) return undefined;
          const info = await this.readInfo(videoId);
          return info ? { ...info.track, usedAt: info.playedAt } : undefined;
        }),
    );
    return found
      .filter((track): track is JamRecentTrack => track !== undefined)
      .sort((a, b) => b.usedAt - a.usedAt || a.videoId.localeCompare(b.videoId));
  }

  private async readInfo(videoId: string): Promise<SongInfo | undefined> {
    try {
      return parseSongInfo(JSON.parse(await readFile(this.infoFor(videoId), 'utf8')), videoId);
    } catch {
      return undefined; // missing or unreadable: the next start rewrites it
    }
  }

  private async writeUse(track: JamTrack, use: SongUse): Promise<void> {
    const { videoId } = track;
    if (!(await this.exists(videoId))) return;
    const before = await this.readInfo(videoId);
    const playedAt =
      before && use.playedAt !== undefined
        ? Math.max(before.playedAt, use.playedAt)
        : (use.playedAt ?? before?.playedAt);
    if (playedAt === undefined) return; // never played: nothing to remember
    const info: SongInfo = { track: use.exact || !before ? { ...track } : before.track, playedAt };
    // Atomic: a temporary file (cleaned up like the uploads' when left behind), then a rename.
    const temp = this.tempFile('.json');
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, ...info })}\n`, { mode: FILE_MODE });
      await renameWithRetry(temp, this.infoFor(videoId));
    } catch (err) {
      await removeFile(temp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Keeps the cache small, never touching a song in `keep` (what some room still plays or
   * queues, or an upload in progress) nor a temporary file in `keepTemps` (absolute paths of the
   * uploads being received): deletes leftover temporary uploads, songs unused for longer than the
   * TTL, then the least recently used songs until the cache fits its size limit. A song's info
   * goes with its audio; infos left without their audio are deleted.
   */
  async maintain(
    keep: ReadonlySet<string>,
    keepTemps: ReadonlySet<string> = new Set(),
  ): Promise<CacheMaintenance> {
    const result: CacheMaintenance = { expired: [], evicted: [], temps: 0, orphans: 0 };
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw err;
    }
    const now = this.now();
    const songs: CachedSong[] = [];
    const audio = new Set(names.filter((name) => CACHED_FILE.test(name)));
    for (const name of names) {
      if (INFO_FILE.test(name)) {
        const videoId = name.slice(0, -'.json'.length);
        // Checked again: the audio may have been stored since the listing.
        if (!audio.has(`${videoId}.webm`) && !(await this.audioPresent(videoId))) {
          await removeFile(join(this.dir, name));
          result.orphans += 1;
        }
        continue;
      }
      const isSong = CACHED_FILE.test(name);
      if (!isSong && !name.startsWith(TEMP_PREFIX)) continue;
      const path = join(this.dir, name);
      let size: number;
      let usedAt: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        size = info.size;
        usedAt = info.mtimeMs;
      } catch {
        continue; // deleted meanwhile
      }
      if (!isSong) {
        // Uploads being received are written to all along; one untouched this long is a leftover.
        if (!keepTemps.has(path) && now - usedAt >= this.tempMaxAgeMs) {
          await removeFile(path);
          result.temps += 1;
        }
        continue;
      }
      const videoId = name.slice(0, -'.webm'.length);
      if (this.ttlMs > 0 && now - usedAt >= this.ttlMs && !keep.has(videoId)) {
        await this.removeSong(videoId);
        result.expired.push(videoId);
        continue;
      }
      songs.push({ videoId, size, usedAt });
    }
    let total = songs.reduce((sum, song) => sum + song.size, 0);
    if (total <= this.maxBytes) return result;
    for (const song of songs.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= this.maxBytes) break;
      if (keep.has(song.videoId)) continue;
      await this.removeSong(song.videoId);
      total -= song.size;
      result.evicted.push(song.videoId);
    }
    if (total > this.maxBytes) {
      this.log.warn(
        { totalBytes: total, maxBytes: this.maxBytes },
        'jam cache over its limit, but every remaining song is queued',
      );
    }
    return result;
  }

  /** Deletes a song's audio and info, in turn with its info writes (one after it finds no audio). */
  private async removeSong(videoId: string): Promise<void> {
    await this.inTurn(videoId, async () => {
      await removeFile(this.fileFor(videoId));
      await removeFile(this.infoFor(videoId));
    });
  }

  /** Whether a song's audio file is there at all (empty or not). */
  private async audioPresent(videoId: string): Promise<boolean> {
    return stat(this.fileFor(videoId)).then(
      () => true,
      () => false,
    );
  }
}
