import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { JAM_UPLOAD_TIMEOUT_MS } from '@concord/shared';
import { renameWithRetry } from '../atomic-file';
import type { Logger } from '../logger';

const CACHED_FILE = /^[A-Za-z0-9_-]{11}\.webm$/;
const TEMP_PREFIX = '.tmp-';

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

  /** A fresh temporary path inside the cache, for an upload being received. */
  tempFile(): string {
    return join(this.dir, `${TEMP_PREFIX}${randomUUID()}.webm`);
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

  /**
   * Keeps the cache small, never touching a song in `keep` (what some room still plays or
   * queues, or an upload in progress) nor a temporary file in `keepTemps` (absolute paths of the
   * uploads being received): deletes leftover temporary uploads, songs unused for longer than the
   * TTL, then the least recently used songs until the cache fits its size limit.
   */
  async maintain(
    keep: ReadonlySet<string>,
    keepTemps: ReadonlySet<string> = new Set(),
  ): Promise<CacheMaintenance> {
    const result: CacheMaintenance = { expired: [], evicted: [], temps: 0 };
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw err;
    }
    const now = this.now();
    const songs: CachedSong[] = [];
    for (const name of names) {
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
        await removeFile(path);
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
      await removeFile(this.fileFor(song.videoId));
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
}
